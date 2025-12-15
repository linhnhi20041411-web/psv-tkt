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
const io = new Server(server, {
    cors: { origin: "*" } 
});

// Biến lưu trữ tạm: Tin nhắn Telegram ID -> Socket ID người dùng
const pendingRequests = new Map();
const socketToMsgId = new Map();

// Lắng nghe kết nối Socket
io.on('connection', (socket) => {
    console.log('👤 User Connected:', socket.id);

    socket.on('disconnect', () => {
        // Dọn dẹp bộ nhớ khi user thoát
        if (socketToMsgId.has(socket.id)) {
            const msgIds = socketToMsgId.get(socket.id);
            if (msgIds) {
                msgIds.forEach(id => pendingRequests.delete(id));
            }
            socketToMsgId.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- 1. CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456"; 

// CẤU HÌNH TELEGRAM
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ""; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

if (!supabaseUrl || !supabaseKey) console.error("❌ LỖI: Thiếu SUPABASE_URL hoặc SUPABASE_KEY");
const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. BỘ TỪ ĐIỂN VIẾT TẮT ---
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

// --- 3. CÁC HÀM TIỆN ÍCH ---
function getRandomStartIndex() { return Math.floor(Math.random() * apiKeys.length); }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: `🤖 <b>PSV ẢO VĂN TƯ TU</b> 🚨\n\n${message}`, parse_mode: 'HTML' });
    } catch (error) { console.error("Telegram Error:", error.message); }
}

function cleanText(text) {
    if (!text) return "";
    let clean = text.replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>/gi, '\n')
                    .replace(/<[^>]*>?/gm, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/\r\n/g, '\n');    
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

// --- 4. GỌI GEMINI (CÓ RETRY & TELEGRAM) ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            console.log("🔁 Hết vòng Key, chờ 2s thử lại...");
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        const msg = "🆘 HẾT SẠCH API KEY! Hệ thống không thể phản hồi.";
        console.error(msg);
        await sendTelegramAlert(msg);
        throw new Error("ALL_KEYS_EXHAUSTED");
    }

    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
    } catch (error) {
        const status = error.response ? error.response.status : 0;
        if (status === 429 || status === 400 || status === 403 || status >= 500) {
            console.warn(`⚠️ Key ${keyIndex} lỗi (Mã: ${status}). Đổi Key...`);
            if (status === 429) await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

// --- 6. AI EXTRACT KEYWORDS (CẬP NHẬT PROMPT ĐỂ TRÁNH "QUY ĐỊNH") ---
async function aiExtractKeywords(userQuestion) {
    const prompt = `
    Nhiệm vụ: Bạn là công cụ trích xuất từ khóa tìm kiếm (SEO).
    INPUT: "${userQuestion}"
    
    YÊU CẦU:
    1. Giữ lại các danh từ, động từ quan trọng nhất (Ví dụ: trẻ em, tụng kinh, chú ý, kiêng kỵ).
    2. Giữ nguyên các thuật ngữ Phật giáo (Ví dụ: Lễ Phật Đại Sám Hối Văn, Chú Đại Bi).
    3. LOẠI BỎ các từ hư từ (là, thì, mà, ở, những, các...).
    4. TUYỆT ĐỐI KHÔNG tự thêm các từ như "Quy định", "Luật", "Quy tắc" nếu người dùng không hỏi.
    5. Kết quả trả về là một chuỗi các từ khóa cách nhau bởi dấu cách.
    
    Input: "${userQuestion}"
    Output:
    `;
    try {
        const startIndex = getRandomStartIndex();
        const response = await callGeminiWithRetry({ contents: [{ parts: [{ text: prompt }] }] }, startIndex);
        let refinedQuery = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || userQuestion;
        refinedQuery = refinedQuery.replace(/\n/g, " ").replace(/["']/g, "").replace(/^Output:\s*/i, "");
        console.log(`🧠 User: "${userQuestion}" -> Key: "${refinedQuery}"`);
        return refinedQuery;
    } catch (e) {
        console.error("Lỗi AI Extract:", e.message);
        return userQuestion;
    }
}

// --- 7. EMBEDDING & SEARCH ---
async function callEmbeddingWithRetry(text, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) {
        await sendTelegramAlert("🆘 Hết Key Embedding (Tạo Vector).");
        throw new Error("Hết Key Embedding.");
    }
    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];

    try {
        const genAI = new GoogleGenerativeAI(currentKey);
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        if (error.message?.includes('429') || error.status === 429) {
            await sleep(500);
            return callEmbeddingWithRetry(text, currentIndex + 1, retryCount + 1);
        }
        throw error;
    }
}

// --- HÀM TÌM KIẾM THÔNG MINH (ĐÃ TỐI ƯU VECTOR + KEYWORD) ---
async function searchSupabaseContext(fullText, keywords) {
    try {
        console.log(`🔎 Vector (Ý): "${fullText}"`);
        console.log(`🔎 Text (Từ): "${keywords}"`);
        
        // 1. Tìm theo Tiêu đề/Nội dung (Dùng TỪ KHÓA để quét nhanh)
        // Dùng 'or' để tìm nếu tiêu đề HOẶC nội dung chứa từ khóa
        const { data: textMatches } = await supabase
            .from('vn_buddhism_content')
            .select('*')
            .or(`content.ilike.%${keywords}%, metadata->>title.ilike.%${keywords}%`) 
            .limit(5);

        // 2. Tìm theo Vector (Dùng CÂU ĐẦY ĐỦ để hiểu ngữ cảnh sâu)
        const startIndex = getRandomStartIndex();
        const queryVector = await callEmbeddingWithRetry(fullText, startIndex);

        const { data: vectorMatches, error: vectorError } = await supabase.rpc('hybrid_search', {
            query_text: keywords, // Gửi từ khóa ngắn gọn cho bộ lọc Text
            query_embedding: queryVector, // Gửi câu đầy đủ cho bộ lọc Vector
            match_count: 30, 
            rrf_k: 60
        });

        if (vectorError) throw vectorError;

        // Gộp kết quả
        const allDocs = [];
        const seenUrls = new Set();

        const addDoc = (doc) => {
            if (!seenUrls.has(doc.url)) {
                seenUrls.add(doc.url);
                allDocs.push(doc);
            }
        };

        if (textMatches) textMatches.forEach(addDoc);
        if (vectorMatches) vectorMatches.forEach(addDoc);

        return allDocs.length > 0 ? allDocs : null;

    } catch (error) {
        console.error("Lỗi tìm kiếm:", error.message);
        // Gửi báo động nếu lỗi Database
        await sendTelegramAlert(`❌ Lỗi Tìm Kiếm Supabase:\n${error.message}`);
        return null; 
    }
}

// --- 8. API CHAT (PHIÊN BẢN ĐƠN GIẢN THEO YÊU CẦU) ---
app.post('/api/chat', async (req, res) => {
    try {
        // 1. Nhận dữ liệu (Thêm socketId để tránh lỗi nếu client có gửi)
        const { question, socketId } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        // 2. Xử lý câu hỏi
        const fullQuestion = dichVietTat(question);
        
        // Bước phân tích từ khóa (Dùng hàm hiện có)
        const searchKeywords = await aiExtractKeywords(fullQuestion);
        
        // 3. Tìm kiếm dữ liệu
        // Lưu ý: Dùng cú pháp (fullQuestion, searchKeywords) để tận dụng thuật toán tìm kiếm tối ưu
        const documents = await searchSupabaseContext(fullQuestion, searchKeywords);

        // 4. Xử lý khi không có dữ liệu (Trả về câu mặc định như bạn muốn)
        if (!documents || documents.length === 0) {
            return res.json({ 
                answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan: https://mucluc.pmtl.site" 
            });
        }

        // 5. Tạo Context
        let contextString = "";
        documents.forEach((doc, index) => {
            contextString += `--- Nguồn #${index + 1} ---\nLink: ${doc.url}\nTiêu đề: ${doc.metadata?.title || 'No Title'}\nNội dung: ${doc.content.substring(0, 800)}...\n`;
        });

        // 6. Prompt (Theo yêu cầu của bạn)
        const systemPrompt = `
        Bạn là Phụng Sự Viên Ảo.
        Câu hỏi gốc: "${fullQuestion}"
        Từ khóa trọng tâm: "${searchKeywords}"
        Dữ liệu tham khảo: ${contextString}
        Yêu cầu: Trả lời câu hỏi dựa trên bài viết khớp nhất với từ khóa. Cuối câu trả lời DÁN LINK GỐC.
        `;

        // 7. Gọi AI (Sửa tên hàm thành callGeminiWithRetry cho khớp với server.js hiện tại)
        const startIndex = getRandomStartIndex();
        const response = await callGeminiWithRetry({ contents: [{ parts: [{ text: systemPrompt }] }] }, startIndex);

        let aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, đệ chưa nghĩ ra câu trả lời.";
        
        // 8. Trả về kết quả
        res.json({ answer: "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        
        // BÁO LỖI VỀ TELEGRAM (Giữ nguyên tính năng này)
        await sendTelegramAlert(`❌ LỖI API CHAT:\nUser: ${req.body.question}\nError: ${error.message}`);
        
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

// --- API WEBHOOK: NHẬN TIN NHẮN TỪ TELEGRAM (HỖ TRỢ ẢNH & TEXT) ---
app.post(`/api/telegram-webhook/${process.env.TELEGRAM_TOKEN}`, async (req, res) => {
    try {
        const { message } = req.body;
        
        // Kiểm tra xem có phải là tin nhắn TRẢ LỜI (Reply) không
        if (message && message.reply_to_message) {
            const originalMsgId = message.reply_to_message.message_id; // ID câu hỏi gốc
            
            // Kiểm tra xem câu hỏi gốc có trong danh sách chờ không
            if (pendingRequests.has(originalMsgId)) {
                const userSocketId = pendingRequests.get(originalMsgId);
                
                // --- TRƯỜNG HỢP 1: ADMIN GỬI ẢNH ---
                if (message.photo) {
                    try {
                        // 1. Lấy file_id của ảnh chất lượng cao nhất (cái cuối cùng trong mảng)
                        const fileId = message.photo[message.photo.length - 1].file_id;
                        
                        // 2. Lấy đường dẫn file từ Telegram
                        const getFileUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
                        const fileInfoRes = await axios.get(getFileUrl);
                        const filePath = fileInfoRes.data.result.file_path;

                        // 3. Tải ảnh về và chuyển sang Base64
                        const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
                        const imageRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                        const base64Image = Buffer.from(imageRes.data, 'binary').toString('base64');
                        const imgSrc = `data:image/jpeg;base64,${base64Image}`;

                        // 4. Gửi ảnh qua Socket
                        io.to(userSocketId).emit('admin_reply_image', imgSrc);
                        console.log(`📸 Đã chuyển ẢNH tới Socket: ${userSocketId}`);

                        // Nếu có caption (chú thích ảnh) thì gửi thêm text
                        if (message.caption) {
                            io.to(userSocketId).emit('admin_reply', message.caption);
                        }

                    } catch (imgError) {
                        console.error("Lỗi xử lý ảnh:", imgError.message);
                        io.to(userSocketId).emit('admin_reply', "[Lỗi: Admin gửi ảnh nhưng hệ thống không tải được]");
                    }
                } 
                // --- TRƯỜNG HỢP 2: ADMIN GỬI TEXT ---
                else if (message.text) {
                    const adminReply = message.text; 
                    io.to(userSocketId).emit('admin_reply', adminReply);
                    console.log(`✅ Đã chuyển TEXT tới Socket: ${userSocketId}`);
                }
                
                // Lưu ý: Không xóa pendingRequests để admin có thể chat tiếp
            }
        }
        res.sendStatus(200); 
    } catch (e) {
        console.error("Lỗi Webhook:", e);
        res.sendStatus(500);
    }
});

// --- CÁC API ADMIN (CÓ BÁO LỖI TELEGRAM) ---

// API SYNC
app.post('/api/admin/sync-blogger', async (req, res) => {
    const { password, blogUrl } = req.body;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Transfer-Encoding', 'chunked');
    if (password !== ADMIN_PASSWORD) { res.write("❌ Sai mật khẩu!\n"); return res.end(); }
    
    try {
        const cleanBlogUrl = blogUrl.replace(/\/$/, "");
        const rssUrl = `${cleanBlogUrl}/feeds/posts/default?alt=rss&max-results=100`;
        res.write(`📡 Kết nối RSS: ${rssUrl}\n`);
        
        const feed = await parser.parseURL(rssUrl);
        res.write(`✅ Tìm thấy ${feed.items.length} bài.\n`);
        
        let errCount = 0;
        for (const post of feed.items) {
            // ... (Logic cũ)
            const { count } = await supabase.from('vn_buddhism_content').select('*', { count: 'exact', head: true }).eq('url', post.link);
            if (count > 0) continue;
            const cleanContent = cleanText(post.content || post['content:encoded'] || "");
            if (cleanContent.length < 50) continue;
            const chunks = chunkText(cleanContent);
            res.write(`⚙️ Nạp: ${post.title.substring(0,30)}...\n`);
            for (const chunk of chunks) {
                try {
                    const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${post.title}\nNội dung: ${chunk}`, getRandomStartIndex());
                    await supabase.from('vn_buddhism_content').insert({
                        content: `Tiêu đề: ${post.title}\nNội dung: ${chunk}`, embedding, url: post.link, original_id: 0, metadata: { title: post.title, type: 'rss_auto' }
                    });
                } catch (e) { 
                    res.write(`❌ Lỗi: ${e.message}\n`); 
                    errCount++;
                }
            }
            await sleep(300);
        }
        if (errCount > 5) {
            // await sendTelegramAlert(`⚠️ Cảnh báo Sync Blogger: Có ${errCount} lỗi xảy ra trong quá trình nạp.`);
        }
        res.write(`\n🎉 HOÀN TẤT!\n`); res.end();
    } catch (e) { 
        res.write(`❌ Lỗi: ${e.message}\n`); 
        //await sendTelegramAlert(`❌ LỖI SYNC BLOGGER:\n${e.message}`);
        res.end(); 
    }
});

// API MANUAL ADD
app.post('/api/admin/manual-add', async (req, res) => {
    const { password, url, title, content } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        await supabase.from('vn_buddhism_content').delete().eq('url', url);
        const chunks = chunkText(cleanText(content));
        for (const chunk of chunks) {
            const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${title}\nNội dung: ${chunk}`, getRandomStartIndex());
            await supabase.from('vn_buddhism_content').insert({
                content: `Tiêu đề: ${title}\nNội dung: ${chunk}`, embedding, url, original_id: 0, metadata: { title, type: 'manual' }
            });
            await sleep(300);
        }
        res.json({ message: "Thành công!", logs: ["Đã lưu xong."] });
    } catch (e) { 
        //await sendTelegramAlert(`❌ Lỗi Manual Add (${title}):\n${e.message}`);
        res.status(500).json({ error: e.message }); 
    }
});

// API CHECK BATCH (Có phát hiện Soft 404)
app.post('/api/admin/check-batch', async (req, res) => {
    const { password, urls } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    
    const results = { checked: 0, deleted: 0, errors: 0, logs: [] };
    const BLOGGER_ERROR_TEXT = "Rất tiếc, trang bạn đang tìm trong blog này không tồn tại";
    
    try {
        for (const url of urls) {
            try {
                const response = await axios.get(url, { timeout: 8000, validateStatus: s => s < 500 });
                let isDead = response.status === 404;
                if (response.status === 200 && typeof response.data === 'string' && response.data.includes(BLOGGER_ERROR_TEXT)) isDead = true;

                if (isDead) {
                    const { error } = await supabase.from('vn_buddhism_content').delete().eq('url', url);
                    if (!error) { results.deleted++; results.logs.push(`🗑️ Đã xóa: ${url}`); } else results.errors++;
                } else results.checked++;
            } catch (err) { results.errors++; }
            await sleep(100);
        }
        res.json(results);
    } catch (e) { 
        //await sendTelegramAlert(`❌ Lỗi Check Batch:\n${e.message}`);
        res.status(500).json({ error: e.message }); 
    }
});

// API Get All Urls & Check Latest (Giữ nguyên, không cần báo lỗi Telegram cho các API đọc dữ liệu đơn giản này)
app.post('/api/admin/get-all-urls', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        let allUrls = [], from = 0, step = 999, keepGoing = true;
        while (keepGoing) {
            const { data, error } = await supabase.from('vn_buddhism_content').select('url').range(from, from + step);
            if (error) throw error;
            if (data.length > 0) { allUrls = allUrls.concat(data.map(i => i.url)); from += step + 1; } else { keepGoing = false; }
        }
        res.json({ success: true, urls: [...new Set(allUrls)] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/check-latest', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        const { data } = await supabase.from('vn_buddhism_content').select('id, url, metadata, created_at').order('id', { ascending: false }).limit(20);
        const unique = []; const seen = new Set();
        data.forEach(i => { if (!seen.has(i.url)) { seen.add(i.url); unique.push(i); } });
        res.json({ success: true, data: unique });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API KIỂM TRA MẬT KHẨU (LOGIN) ---
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(403).json({ error: "Sai mật khẩu!" });
    }
});

// --- API TÌM KIẾM BÀI VIẾT (ĐỂ SỬA) ---
app.post('/api/admin/search-posts', async (req, res) => {
    const { password, keyword } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });

    try {
        // Tìm theo URL hoặc Tiêu đề (trong metadata)
        const { data, error } = await supabase
            .from('vn_buddhism_content')
            .select('id, url, content, metadata, created_at')
            .or(`url.ilike.%${keyword}%, content.ilike.%${keyword}%`)
            .limit(20); // Chỉ lấy 20 kết quả đầu để đỡ lag

        if (error) throw error;
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API CẬP NHẬT BÀI VIẾT (SỬA & RE-EMBEDDING) ---
app.post('/api/admin/update-post', async (req, res) => {
    const { password, id, content, title } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });

    try {
        // 1. Tính toán lại Vector cho nội dung mới (QUAN TRỌNG)
        // Nếu sửa nội dung mà không sửa vector, AI sẽ tìm kiếm dựa trên nội dung cũ -> Sai lệch.
        const fullText = `Tiêu đề: ${title}\nNội dung: ${content}`;
        const embedding = await callEmbeddingWithRetry(fullText, getRandomStartIndex());

        // 2. Cập nhật vào Supabase
        const { error } = await supabase
            .from('vn_buddhism_content')
            .update({ 
                content: fullText,
                embedding: embedding,
                metadata: { title: title, type: 'edited' } // Đánh dấu là đã sửa
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true, message: "Đã cập nhật nội dung và vector thành công!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API XÓA BÀI VIẾT (Hỗ trợ xóa theo ID hoặc URL) ---
app.post('/api/admin/delete-post', async (req, res) => {
    const { password, id, url, title } = req.body; 
    
    console.log(`👉 Yêu cầu xóa: ${id ? 'ID=' + id : 'URL=' + url}`); 

    if (!id && !url) {
        return res.status(400).json({ error: "Lỗi: Cần cung cấp ID hoặc URL để xóa!" });
    }

    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Sai mật khẩu!" });
    }

    try {
        let query = supabase.from('vn_buddhism_content').delete();

        // Nếu có ID thì xóa theo ID (xóa 1 dòng)
        if (id) {
            query = query.eq('id', id);
        } 
        // Nếu có URL thì xóa tất cả bài trùng URL này (Dọn rác triệt để)
        else if (url) {
            query = query.eq('url', url);
        }

        const { error, count } = await query; // count sẽ cho biết xóa được bao nhiêu dòng

        if (error) throw error;

        // Báo Telegram
        const msgType = id ? `ID: ${id}` : `URL: ${url}`;
        //await sendTelegramAlert(`🗑️ <b>ADMIN ĐÃ XÓA DỮ LIỆU</b>\n\n🎯 Đối tượng: ${msgType}\n📝 Ghi chú: ${title || "Dọn dẹp thủ công"}`);

        res.json({ success: true, message: `Đã xóa thành công!` });

    } catch (e) {
        console.error("Lỗi xóa bài:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- API XÓA BÀI TRÙNG LẶP (PHIÊN BẢN TỐI ƯU: BỎ QUA KHOẢNG TRẮNG) ---
app.post('/api/admin/remove-duplicates', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        res.write("🔍 Đang tải toàn bộ dữ liệu...\n");

        let allData = [];
        let from = 0;
        const pageSize = 1000;
        let keepFetching = true;

        // 1. Tải dữ liệu
        while (keepFetching) {
            const { data, error } = await supabase
                .from('vn_buddhism_content')
                .select('id, url, content') // Lấy ID, URL và Content
                .range(from, from + pageSize - 1);

            if (error) throw error;

            if (data.length === 0) {
                keepFetching = false;
            } else {
                allData = allData.concat(data);
                from += pageSize;
                res.write(`... Đã tải: ${allData.length} dòng\n`);
                if (data.length < pageSize) keepFetching = false;
            }
        }

        res.write(`📂 Tổng: ${allData.length} bản ghi. Đang phân tích...\n`);

        const seen = new Set();
        const duplicateIds = [];

        // 2. Phân tích tìm trùng lặp (Logic mới)
        for (const item of allData) {
            // Chuẩn hóa Content: Xóa hết dấu cách, xuống dòng, chỉ giữ lại chữ cái
            // Mục đích: Để "Tiêu đề: A" và "Tiêu đề:A" được coi là giống nhau
            const cleanContent = item.content 
                ? item.content.substring(0, 150).replace(/\s+/g, '').toLowerCase() 
                : "empty";
            
            // Chữ ký = URL + Nội dung đã chuẩn hóa
            const signature = `${item.url}|||${cleanContent}`;

            if (seen.has(signature)) {
                // Nếu đã thấy chữ ký này rồi -> Đây là bản sao -> Đánh dấu xóa
                duplicateIds.push(item.id);
            } else {
                // Nếu chưa thấy -> Đây là bản gốc -> Giữ lại
                seen.add(signature);
            }
        }

        if (duplicateIds.length === 0) {
            res.write("✅ Database sạch sẽ! Không có bài trùng.\n");
            return res.end();
        }

        res.write(`⚠️ Phát hiện ${duplicateIds.length} rác trùng lặp.\n`);
        res.write("🗑️ Đang xóa...\n");

        // 3. Xóa theo lô (Batch Delete)
        const batchSize = 100;
        for (let i = 0; i < duplicateIds.length; i += batchSize) {
            const batch = duplicateIds.slice(i, i + batchSize);
            const { error: delError } = await supabase
                .from('vn_buddhism_content')
                .delete()
                .in('id', batch);
            
            if (delError) {
                res.write(`❌ Lỗi xóa lô ${i}: ${delError.message}\n`);
            } else {
                res.write(`✅ Đã dọn dẹp lô ${i + 1} - ${Math.min(i + batchSize, duplicateIds.length)}\n`);
            }
        }

        res.write(`🎉 HOÀN TẤT! Đã giải phóng bộ nhớ Database.\n`);
        res.end();

    } catch (e) {
        console.error("Lỗi:", e);
        res.write(`❌ Lỗi hệ thống: ${e.message}\n`);
        res.end();
    }
});

// --- API TEST TELEGRAM (Dùng để kiểm tra kết nối) ---
app.get('/api/test-telegram', async (req, res) => {
    try {
        await sendTelegramAlert("🚀 <b>Test thành công!</b>\nServer của Sư huynh đã kết nối được với Telegram.\n\nChúc Sư huynh một ngày an lạc! 🙏");
        res.json({ success: true, message: "Đã gửi tin nhắn. Sư huynh kiểm tra điện thoại nhé!" });
    } catch (error) {
        res.status(500).json({ error: "Lỗi gửi Telegram: " + error.message });
    }
});

server.listen(PORT, () => {
    console.log(`Server Socket.io đang chạy tại http://localhost:${PORT}`);
});
