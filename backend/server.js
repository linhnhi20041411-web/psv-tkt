const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser'); 
require('dotenv').config();

const parser = new Parser();
const app = express();
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
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: `🤖 <b>CẢNH BÁO CHATBOT</b> 🚨\n\n${message}`, parse_mode: 'HTML' });
    } catch (error) { console.error("Telegram Error:", error.message); }
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

// --- 5. AI EXTRACT & EMBEDDING ---
async function aiExtractKeywords(userQuestion) {
    // Dùng prompt đơn giản để lấy từ khóa tìm kiếm trước
    const prompt = `Trích xuất từ khóa tìm kiếm chính (bỏ từ hư từ) cho câu: "${userQuestion}"`;
    try {
        const response = await callGeminiWithRetry({ contents: [{ parts: [{ text: prompt }] }] }, getRandomStartIndex());
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || userQuestion;
    } catch (e) { return userQuestion; }
}

async function callEmbeddingWithRetry(text, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) { await sendTelegramAlert("Hết key embedding"); throw new Error("Hết Key Embedding."); }
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

async function searchSupabaseContext(query) {
    try {
        const queryVector = await callEmbeddingWithRetry(query, getRandomStartIndex());
        const { data, error } = await supabase.rpc('hybrid_search', {
            query_text: query, query_embedding: queryVector, match_count: 30, rrf_k: 60
        });
        if (error) throw error;
        return data && data.length > 0 ? data : null;
    } catch (error) { console.error("Lỗi tìm kiếm:", error.message); return null; }
}

// --- 6. API CHAT (KẾT HỢP LOGIC CỦA BẠN VÀO ĐÂY) ---
app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        // A. TÌM KIẾM DỮ LIỆU (Giữ nguyên logic Supabase để lấy Context)
        const fullQuestion = dichVietTat(question);
        const searchKeywords = await aiExtractKeywords(fullQuestion);
        console.log(`🗣️ User: "${question}" -> Key: "${searchKeywords}"`);
        const documents = await searchSupabaseContext(searchKeywords);

        if (!documents) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan: https://mucluc.pmtl.site" });
        }

        // Tạo Context String từ Supabase
        let contextString = "";
        documents.forEach((doc, index) => {
            contextString += `\n[Tài liệu ${index + 1}]\nLink: ${doc.url}\nNội dung: ${doc.content.substring(0, 1500)}...\n`;
        });

        // B. GỌI GEMINI (ÁP DỤNG MÃ NGUỒN CỦA BẠN TẠI ĐÂY)
        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        // --- BƯỚC 1: PROMPT GỐC (Dựa trên code bạn gửi) ---
        const promptGoc = `Bạn là một công cụ trích xuất thông tin chính xác.
        Nhiệm vụ: Trả lời câu hỏi dựa trên "VĂN BẢN NGUỒN" bên dưới.

        QUY TẮC BẮT BUỘC:
        1. NGUỒN DỮ LIỆU: Chỉ sử dụng thông tin trong "VĂN BẢN NGUỒN". Không dùng kiến thức ngoài.
        2. ĐỊNH DẠNG: Trả lời dạng gạch đầu dòng, ngắn gọn.
        3. TRÍCH DẪN LINK: Cuối mỗi ý quan trọng, PHẢI kèm theo Link gốc của bài viết đó (Lấy từ phần Link trong văn bản nguồn). 
           Ví dụ: - Nội dung trả lời [Link gốc]
        4. XƯNG HÔ: Tự xưng "đệ", gọi người hỏi "Sư huynh".
        5. KHÔNG TÌM THẤY: Nếu không có tin, nói: "Mời Sư huynh tra cứu thêm tại: https://mucluc.pmtl.site".

        --- VĂN BẢN NGUỒN ---
        ${contextString}
        --- HẾT VĂN BẢN NGUỒN ---
        
        Câu hỏi: ${fullQuestion}
        Câu trả lời:`;

        console.log("--> Đang thử Prompt Gốc...");
        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            safetySettings: safetySettings,
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        }, 0);

        let aiResponse = "";
        let finishReason = "";

        if (response.data && response.data.candidates && response.data.candidates.length > 0) {
            const candidate = response.data.candidates[0];
            finishReason = candidate.finishReason;
            if (candidate.content?.parts?.[0]?.text) {
                aiResponse = candidate.content.parts[0].text;
            }
        }

        // --- BƯỚC 2: CHIẾN THUẬT CỨU NGUY (RECITATION FALLBACK) ---
        if (finishReason === "RECITATION" || !aiResponse) {
            console.log("⚠️ Prompt Gốc bị chặn (Recitation). Kích hoạt Prompt Diễn Giải...");

            const promptDienGiai = `Bạn là trợ lý tu tập.
            NV: Trả lời câu hỏi: "${fullQuestion}" dựa trên văn bản nguồn.
            VẤN ĐỀ: Việc trích dẫn nguyên văn bị lỗi bản quyền.
            GIẢI PHÁP:
            1. Đọc hiểu ý chính.
            2. VIẾT LẠI (Diễn giải) các ý đó dưới dạng gạch đầu dòng, ngôn ngữ súc tích.
            3. Giữ nguyên thuật ngữ Phật học.
            4. Vẫn phải kèm Link gốc vào cuối mỗi ý nếu có thể.
            5. Bắt đầu bằng: "Do hạn chế về bản quyền, đệ xin tóm lược ý chính:".

            --- VĂN BẢN NGUỒN ---
            ${contextString}
            `;

            response = await callGeminiWithRetry({
                contents: [{ parts: [{ text: promptDienGiai }] }],
                safetySettings: safetySettings,
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
            }, 0);

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = response.data.candidates[0].content.parts[0].text;
            } else {
                aiResponse = "Nội dung này Google chặn tuyệt đối (Recitation). Sư huynh vui lòng xem trực tiếp trên web ạ.";
                await sendTelegramAlert(`⚠️ Recitation Blocked 2 lần: ${fullQuestion}`);
            }
        }

        // TRẢ KẾT QUẢ
        let finalAnswer = "";
        if (aiResponse.includes("mucluc.pmtl.site") && aiResponse.length < 150) {
             finalAnswer = aiResponse;
        } else {
            // Loại bỏ các dòng thừa nếu AI lỡ thêm vào
            aiResponse = aiResponse.replace(/\*\*Phụng Sự Viên Ảo Trả Lời :\*\*/g, "").trim();
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        await sendTelegramAlert(`❌ LỖI API CHAT:\n${error.message}`);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
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
        if (errCount > 5) await sendTelegramAlert(`⚠️ Cảnh báo Sync Blogger: Có ${errCount} lỗi xảy ra trong quá trình nạp.`);
        res.write(`\n🎉 HOÀN TẤT!\n`); res.end();
    } catch (e) { 
        res.write(`❌ Lỗi: ${e.message}\n`); 
        await sendTelegramAlert(`❌ LỖI SYNC BLOGGER:\n${e.message}`);
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
        await sendTelegramAlert(`❌ Lỗi Manual Add (${title}):\n${e.message}`);
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
        await sendTelegramAlert(`❌ Lỗi Check Batch:\n${e.message}`);
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

// --- API XÓA BÀI TRÙNG LẶP (DEDUPLICATE) ---
app.post('/api/admin/remove-duplicates', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });

    // Stream log về client
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        res.write("🔍 Đang tải toàn bộ dữ liệu để đối chiếu (có thể mất vài giây)...\n");
        
        // Lấy toàn bộ ID, URL và Content (Băm nhỏ để so sánh)
        // Lưu ý: Nếu dữ liệu quá lớn (>10.000 dòng), cần pagination. Ở đây giả sử <10.000
        const { data, error } = await supabase
            .from('vn_buddhism_content')
            .select('id, url, content');

        if (error) throw error;

        res.write(`📂 Tổng số bản ghi: ${data.length}\n`);
        
        const seen = new Set();
        const duplicateIds = [];

        // Duyệt qua từng dòng
        for (const item of data) {
            // Tạo "chữ ký" duy nhất: URL + 100 ký tự đầu của Content
            // (Lý do: Một bài viết dài có nhiều chunks cùng URL, nên phải so cả Content)
            const signature = `${item.url}|||${item.content.substring(0, 100)}`;

            if (seen.has(signature)) {
                // Nếu đã thấy chữ ký này rồi -> Đây là bản sao -> Xóa
                duplicateIds.push(item.id);
            } else {
                seen.add(signature);
            }
        }

        if (duplicateIds.length === 0) {
            res.write("✅ Tuyệt vời! Không phát hiện dữ liệu trùng lặp.\n");
            return res.end();
        }

        res.write(`⚠️ Phát hiện ${duplicateIds.length} bản ghi trùng lặp.\n`);
        res.write("🗑️ Đang tiến hành xóa...\n");

        // Chia nhỏ mảng ID để xóa (Supabase giới hạn số lượng trong 1 lệnh)
        const batchSize = 100;
        for (let i = 0; i < duplicateIds.length; i += batchSize) {
            const batch = duplicateIds.slice(i, i + batchSize);
            const { error: delError } = await supabase
                .from('vn_buddhism_content')
                .delete()
                .in('id', batch);
            
            if (delError) {
                res.write(`❌ Lỗi xóa batch ${i}: ${delError.message}\n`);
            } else {
                res.write(`✅ Đã xóa lô ${i + 1} - ${Math.min(i + batchSize, duplicateIds.length)}\n`);
            }
        }

        res.write(`🎉 HOÀN TẤT! Đã dọn dẹp sạch sẽ Database.\n`);
        res.end();

    } catch (e) {
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

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
