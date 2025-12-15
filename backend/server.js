const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io");
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser'); 
require('dotenv').config();

const parser = new Parser();
const app = express();

// --- KHỞI TẠO SERVER & SOCKET ---
const server = http.createServer(app); 
app.use(cors()); // Mở khóa CORS cho mọi nguồn
const io = new Server(server, {
    cors: { origin: "*" } 
});

// Biến lưu trữ tạm
const pendingRequests = new Map();
const socketToMsgId = new Map();

io.on('connection', (socket) => {
    console.log('👤 User Connected:', socket.id);
    socket.on('disconnect', () => {
        if (socketToMsgId.has(socket.id)) {
            const msgIds = socketToMsgId.get(socket.id);
            if (msgIds) msgIds.forEach(id => pendingRequests.delete(id));
            socketToMsgId.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3001;
app.use(express.json({ limit: '50mb' }));

// --- CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456"; 
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ""; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

if (!supabaseUrl || !supabaseKey) console.error("❌ LỖI: Thiếu SUPABASE_URL hoặc SUPABASE_KEY");
const supabase = createClient(supabaseUrl, supabaseKey);

// --- TỪ ĐIỂN VIẾT TẮT ---
const TU_DIEN_VIET_TAT = {
    "pmtl": "Pháp Môn Tâm Linh", "btpp": "Bạch Thoại Phật Pháp", "nnn": "Ngôi nhà nhỏ", "psv": "Phụng Sự Viên", "sh": "Sư Huynh",
    "kbt": "Kinh Bài Tập", "cđb": "Chú Đại Bi", "cdb": "Chú Đại Bi", "tk": "Tâm Kinh", "lpdshv": "Lễ Phật Đại Sám Hối Văn",
    "vsc": "Vãng Sanh Chú", "cdbstc": "Công Đức Bảo Sơn Thần Chú", "cđbstc": "Công Đức Bảo Sơn Thần Chú",
    "nyblvdln": "Như Ý Bảo Luân Vương Đà La Ni", "bkcn": "Bổ Khuyết Chân Ngôn", "tpdtcn": "Thất Phật Diệt Tội Chân Ngôn",
    "qalccn": "Quán Âm Linh Cảm Chân Ngôn", "tvltqdqmvtdln": "Thánh Vô Lượng Thọ Quyết Định Quang Minh Vương Đà La Ni",
    "ps": "Phóng Sinh", "xf": "Xoay pháp", "knt": "Khai Nghiệp Tướng", "ht": "Huyền Trang"
};

function dichVietTat(text) {
    if (!text) return "";
    let processedText = text;
    const keys = Object.keys(TU_DIEN_VIET_TAT).sort((a, b) => b.length - a.length);
    keys.forEach(shortWord => {
        const regex = new RegExp(`\\b${shortWord}\\b`, 'gi');
        processedText = processedText.replace(regex, TU_DIEN_VIET_TAT[shortWord]);
    });
    return processedText;
}

// --- TIỆN ÍCH ---
function getRandomStartIndex() { return Math.floor(Math.random() * apiKeys.length); }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm thoát ký tự đặc biệt ĐỂ TRÁNH LỖI 400 TELEGRAM
function escapeHtml(text) {
    if (!text) return "";
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: `🤖 <b>PSV ẢO</b> 🚨\n\n${message}`, parse_mode: 'HTML' });
    } catch (error) { console.error("Telegram Error:", error.message); }
}

function cleanText(text) {
    if (!text) return "";
    let clean = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ');    
    return clean.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

function chunkText(text, maxChunkSize = 2000) {
    if (!text) return [];
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = "";
    for (const p of paragraphs) {
        const cleanP = p.trim();
        if (!cleanP) continue;
        if ((currentChunk.length + cleanP.length) < maxChunkSize) { 
            currentChunk += (currentChunk ? "\n\n" : "") + cleanP; 
        } else { 
            if (currentChunk.length > 50) chunks.push(currentChunk); 
            currentChunk = cleanP; 
        }
    }
    if (currentChunk.length > 50) chunks.push(currentChunk);
    return chunks;
}

// --- GỌI GEMINI ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        await sendTelegramAlert("🆘 HẾT SẠCH API KEY!");
        throw new Error("ALL_KEYS_EXHAUSTED");
    }
    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;
    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
    } catch (error) {
        if (error.response && [429, 400, 403, 500, 503].includes(error.response.status)) {
            console.warn(`⚠️ Key ${keyIndex} lỗi. Đổi Key...`);
            if (error.response.status === 429) await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

// --- 6. AI PHÂN TÍCH TỪ KHÓA ---
async function aiExtractKeywords(userQuestion) {
    const prompt = `
    Nhiệm vụ: Phân tích câu hỏi tìm kiếm dữ liệu Phật giáo.
    Input: "${userQuestion}"
    
    YÊU CẦU TRẢ VỀ JSON (Không markdown):
    {
        "search_query": "Câu hỏi được viết lại ngắn gọn để tìm Vector",
        "must_have": ["Từ khóa 1", "Từ khóa 2"] 
    }

    QUY TẮC must_have (TỪ KHÓA BẮT BUỘC):
    1. Chọn danh từ cụ thể nhất (Ví dụ: "Trẻ em", "Thai phụ", "Ăn mặn").
    2. Chọn tên kinh cụ thể (Ví dụ: "Lễ Phật Đại Sám Hối Văn", "Chú Đại Bi").
    3. KHÔNG chọn từ chung chung (như: niệm, tụng, là gì, sao, thế nào).
    4. Nếu không có từ khóa đặc biệt, để mảng rỗng [].

    VÍ DỤ:
    - In: "Trẻ em niệm lpdshv cần chú ý gì"
    - Out: {"search_query": "lưu ý trẻ em tụng Lễ Phật Đại Sám Hối Văn", "must_have": ["trẻ em", "Lễ Phật Đại Sám Hối Văn"]}
    `;

    try {
        const startIndex = getRandomStartIndex();
        const response = await callGeminiWithRetry({ 
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" } 
        }, startIndex);
        
        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return JSON.parse(text); 
    } catch (e) {
        console.error("Lỗi AI Extract:", e.message);
        return { search_query: userQuestion, must_have: [] };
    }
}

// --- EMBEDDING ---
async function callEmbeddingWithRetry(text, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) throw new Error("Hết Key Embedding.");
    const currentIndex = keyIndex % apiKeys.length;
    try {
        const genAI = new GoogleGenerativeAI(apiKeys[currentIndex]);
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        if (error.status === 429) { await sleep(500); return callEmbeddingWithRetry(text, currentIndex + 1, retryCount + 1); }
        throw error;
    }
}

// --- 7. TÌM KIẾM & SÀNG LỌC (RERANKING LOGIC) ---
async function searchSupabaseContext(aiAnalysis) {
    try {
        const { search_query, must_have } = aiAnalysis;
        console.log(`🔎 Tìm: "${search_query}" | Bắt buộc có: [${must_have.join(', ')}]`);

        // 1. TẠO VECTOR
        const startIndex = getRandomStartIndex();
        const queryVector = await callEmbeddingWithRetry(search_query, startIndex);

        // 2. GỌI DATABASE (Lấy 50 bài)
        const { data: rawDocs, error } = await supabase.rpc('hybrid_search', {
            query_text: search_query, 
            query_embedding: queryVector, 
            match_count: 50, 
            rrf_k: 60
        });

        if (error) throw error;
        if (!rawDocs || rawDocs.length === 0) return null;

        // 3. BỘ LỌC KHỬ RÁC
        let filteredDocs = rawDocs.filter(doc => {
            const contentLower = (doc.content + " " + (doc.metadata?.title || "")).toLowerCase();
            const hasAllKeywords = must_have.every(kw => contentLower.includes(kw.toLowerCase()));
            return hasAllKeywords;
        });

        console.log(`🧹 Lọc rác: Tìm thấy ${rawDocs.length} -> Giữ lại ${filteredDocs.length} bài khớp từ khóa.`);

        // 4. FALLBACK
        if (filteredDocs.length === 0 && must_have.length > 0) {
            console.log("⚠️ Lọc kỹ quá mất hết bài, thử nới lỏng...");
            filteredDocs = rawDocs.filter(doc => {
                const contentLower = (doc.content + " " + (doc.metadata?.title || "")).toLowerCase();
                return contentLower.includes(must_have[0].toLowerCase());
            });
        }

        if (filteredDocs.length === 0) {
            filteredDocs = rawDocs.slice(0, 3);
        }

        // 5. TRẢ VỀ TOP 5
        const uniqueDocs = [];
        const seenUrls = new Set();
        
        for (const doc of filteredDocs) {
            if (!seenUrls.has(doc.url)) {
                seenUrls.add(doc.url);
                uniqueDocs.push(doc);
                if (uniqueDocs.length >= 5) break; 
            }
        }

        return uniqueDocs.length > 0 ? uniqueDocs : null;

    } catch (error) {
        console.error("Lỗi tìm kiếm:", error.message);
        return null; 
    }
}

// --- 8. API CHAT (BẢN FIX LỖI 400 BAD REQUEST) ---
app.post('/api/chat', async (req, res) => {
    try {
        const { question, socketId } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        const fullQuestion = dichVietTat(question);
        const aiAnalysis = await aiExtractKeywords(fullQuestion);
        
        // Tìm kiếm với bộ lọc
        const documents = await searchSupabaseContext(aiAnalysis);

        const HEADER_MSG = "Đệ chào Sư huynh ! sau đây là tất cả các kết quả tìm kiếm đệ tìm được trong thư viện khai thị hiện tại . Mong rằng các kết quả sau đây sẽ mang lại lợi ích tới cho Sư huynh ạ !\n\n";
        const FOOTER_MSG = "\n\nSư huynh có thể tìm thêm các khai thị của Sư Phụ tại địa chỉ : https://tkt.pmtl.site/";

        let needHumanSupport = false;
        let aiResponse = "";

        if (!documents || documents.length === 0) {
            needHumanSupport = true;
        } else {
            // Chuẩn bị dữ liệu
            let contextString = "";
            documents.forEach((doc, index) => {
                contextString += `--- Bài #${index + 1} ---\nLink Gốc: ${doc.url}\nNội dung: ${doc.content.substring(0, 1500)}\n`;
            });

            // --- PROMPT MỚI: QUYẾT LIỆT HƠN ---
            const systemPrompt = `
            NHIỆM VỤ: Trích xuất thông tin trả lời cho câu hỏi: "${fullQuestion}".
            
            DỮ LIỆU THAM KHẢO (Đã được lọc là có chứa từ khóa liên quan):
            ${contextString}

            YÊU CẦU:
            1. Trích xuất tất cả các ý liên quan đến câu hỏi trong dữ liệu trên.
            2. Trình bày dạng gạch đầu dòng (-).
            3. Dưới mỗi ý PHẢI DÁN link bài gốc.
            4. KHÔNG chào hỏi, KHÔNG kết luận.
            5. Nếu dữ liệu thực sự hoàn toàn không liên quan (ví dụ nói về chủ đề khác hẳn), mới được trả về: "NO_INFO".
            
            Mẫu:
            - Nội dung A...
            Link: [URL]
            `;

            const startIndex = getRandomStartIndex();
            const response = await callGeminiWithRetry({ contents: [{ parts: [{ text: systemPrompt }] }] }, startIndex);
            aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "NO_INFO";
            
            if (aiResponse.includes("NO_INFO")) needHumanSupport = true;
        }

        // --- XỬ LÝ KẾT QUẢ ---
        if (needHumanSupport) {
            console.log("⚠️ Không tìm thấy -> Chuyển Telegram.");

            // FIX LỖI 400 Ở ĐÂY: Xử lý ký tự đặc biệt thật kỹ
            const safeUserQ = escapeHtml(question);

            const teleRes = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                // Đã bỏ phần JSON phức tạp, chỉ gửi câu hỏi để tránh lỗi định dạng
                text: `❓ <b>KHÔNG TÌM THẤY DỮ LIỆU</b>\n\nUser: ${safeUserQ}\n\n👉 <i>Admin hãy Reply để trả lời.</i>`,
                parse_mode: 'HTML'
            });

            if (teleRes.data && teleRes.data.result && socketId) {
                const msgId = teleRes.data.result.message_id;
                pendingRequests.set(msgId, socketId);
                if (!socketToMsgId.has(socketId)) socketToMsgId.set(socketId, []);
                socketToMsgId.get(socketId).push(msgId);
            }

            return res.json({ 
                answer: "Đệ đang chuyển câu hỏi của Sư huynh cho các PSV khác hỗ trợ, mong Sư huynh chờ trong giây lát nhé ! 🙏" 
            });
        }

        let cleanBody = aiResponse.replace(/^Output:\s*/i, "").replace(/```/g, "").trim();
        res.json({ answer: HEADER_MSG + cleanBody + FOOTER_MSG });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        // Tạm thời tắt gửi lỗi Telegram ở đây để tránh lặp vô tận nếu chính Telegram bị lỗi 400
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

// --- API WEBHOOK TELEGRAM ---
app.post(`/api/telegram-webhook/${process.env.TELEGRAM_TOKEN}`, async (req, res) => {
    try {
        const { message } = req.body;
        if (message && message.reply_to_message) {
            const originalMsgId = message.reply_to_message.message_id; 
            if (pendingRequests.has(originalMsgId)) {
                const userSocketId = pendingRequests.get(originalMsgId);
                
                if (message.photo) {
                    try {
                        const fileId = message.photo[message.photo.length - 1].file_id;
                        const getFileUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
                        const fileInfoRes = await axios.get(getFileUrl);
                        const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfoRes.data.result.file_path}`;
                        const imageRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                        const base64Image = Buffer.from(imageRes.data, 'binary').toString('base64');
                        
                        io.to(userSocketId).emit('admin_reply_image', `data:image/jpeg;base64,${base64Image}`);
                        if (message.caption) io.to(userSocketId).emit('admin_reply', message.caption);
                    } catch (e) { io.to(userSocketId).emit('admin_reply', "[Lỗi tải ảnh]"); }
                } else if (message.text) {
                    io.to(userSocketId).emit('admin_reply', message.text);
                }
            }
        }
        res.sendStatus(200); 
    } catch (e) { console.error(e); res.sendStatus(500); }
});

// --- CÁC API ADMIN (GIỮ NGUYÊN) ---

app.post('/api/admin/sync-blogger', async (req, res) => {
    const { password, blogUrl } = req.body;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Transfer-Encoding', 'chunked');
    if (password !== ADMIN_PASSWORD) { res.write("❌ Sai mật khẩu!\n"); return res.end(); }
    try {
        const cleanBlogUrl = blogUrl.replace(/\/$/, "");
        const feed = await parser.parseURL(`${cleanBlogUrl}/feeds/posts/default?alt=rss&max-results=100`);
        res.write(`✅ Tìm thấy ${feed.items.length} bài.\n`);
        for (const post of feed.items) {
            const { count } = await supabase.from('vn_buddhism_content').select('*', { count: 'exact', head: true }).eq('url', post.link);
            if (count > 0) continue;
            const chunks = chunkText(cleanText(post.content || post['content:encoded'] || ""));
            res.write(`⚙️ Nạp: ${post.title.substring(0,30)}...\n`);
            for (const chunk of chunks) {
                try {
                    const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${post.title}\nNội dung: ${chunk}`, getRandomStartIndex());
                    await supabase.from('vn_buddhism_content').insert({
                        content: `Tiêu đề: ${post.title}\nNội dung: ${chunk}`, embedding, url: post.link, original_id: 0, metadata: { title: post.title, type: 'rss_auto' }
                    });
                } catch (e) { res.write(`❌ Lỗi: ${e.message}\n`); }
            }
            await sleep(300);
        }
        res.write(`\n🎉 HOÀN TẤT!\n`); res.end();
    } catch (e) { res.write(`❌ Lỗi: ${e.message}\n`); res.end(); }
});

app.post('/api/admin/manual-add', async (req, res) => {
    const { password, url, title, content } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        await supabase.from('vn_buddhism_content').delete().eq('url', url);
        const chunks = chunkText(cleanText(content));
        for (const chunk of chunks) {
            const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${title}\nNội dung: ${chunk}`, getRandomStartIndex());
            await supabase.from('vn_buddhism_content').insert({ content: `Tiêu đề: ${title}\nNội dung: ${chunk}`, embedding, url, original_id: 0, metadata: { title, type: 'manual' } });
            await sleep(300);
        }
        res.json({ message: "Thành công!" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/delete-post', async (req, res) => {
    const { password, id, url } = req.body; 
    if (!id && !url) return res.status(400).json({ error: "Thiếu ID hoặc URL!" });
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        let query = supabase.from('vn_buddhism_content').delete();
        if (id) query = query.eq('id', id); else if (url) query = query.eq('url', url);
        await query;
        res.json({ success: true, message: `Đã xóa!` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/remove-duplicates', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Transfer-Encoding', 'chunked');
    try {
        res.write("🔍 Đang quét...\n");
        let allData = [], from = 0, keep = true;
        while (keep) {
            const { data } = await supabase.from('vn_buddhism_content').select('id, url, content').range(from, from + 999);
            if (!data || data.length === 0) keep = false;
            else { allData = allData.concat(data); from += 1000; res.write(`... Tải ${allData.length} dòng\n`); }
        }
        const seen = new Set(), dupIds = [];
        for (const item of allData) {
            const sig = `${item.url}|||${item.content ? item.content.substring(0, 150).replace(/\s+/g, '').toLowerCase() : ""}`;
            if (seen.has(sig)) dupIds.push(item.id); else seen.add(sig);
        }
        if (dupIds.length === 0) { res.write("✅ Sạch sẽ!\n"); return res.end(); }
        res.write(`🗑️ Xóa ${dupIds.length} bài trùng...\n`);
        for (let i = 0; i < dupIds.length; i += 100) {
            await supabase.from('vn_buddhism_content').delete().in('id', dupIds.slice(i, i + 100));
        }
        res.write(`🎉 Xong!\n`); res.end();
    } catch (e) { res.write(`❌ Lỗi: ${e.message}\n`); res.end(); }
});

app.post('/api/admin/check-batch', async (req, res) => {
    const { password, urls } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        let deleted = 0;
        for (const url of urls) {
            try {
                const r = await axios.get(url, { timeout: 8000, validateStatus: s => s < 500 });
                if (r.status === 404 || (typeof r.data === 'string' && r.data.includes("không tồn tại"))) {
                    await supabase.from('vn_buddhism_content').delete().eq('url', url); deleted++;
                }
            } catch (e) {}
            await sleep(100);
        }
        res.json({ checked: urls.length, deleted });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/get-all-urls', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        let allUrls = [], from = 0, keep = true;
        while (keep) {
            const { data } = await supabase.from('vn_buddhism_content').select('url').range(from, from + 999);
            if (data.length > 0) { allUrls = allUrls.concat(data.map(i => i.url)); from += 1000; } else keep = false;
        }
        res.json({ success: true, urls: [...new Set(allUrls)] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/search-posts', async (req, res) => {
    const { password, keyword } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    const { data } = await supabase.from('vn_buddhism_content').select('id, url, content, metadata').or(`url.ilike.%${keyword}%, content.ilike.%${keyword}%`).limit(20);
    res.json({ success: true, data });
});

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true }); else res.status(403).json({ error: "Sai mật khẩu!" });
});

app.post('/api/admin/update-post', async (req, res) => {
    const { password, id, content, title } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${title}\nNội dung: ${content}`, getRandomStartIndex());
        await supabase.from('vn_buddhism_content').update({ content: `Tiêu đề: ${title}\nNội dung: ${content}`, embedding, metadata: { title, type: 'edited' } }).eq('id', id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test-telegram', async (req, res) => {
    await sendTelegramAlert("🚀 Test OK"); res.json({ success: true });
});

server.listen(PORT, () => {
    console.log(`Server Socket.io đang chạy tại http://localhost:${PORT}`);
});
