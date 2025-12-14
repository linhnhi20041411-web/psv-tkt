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

// --- CẤU HÌNH TELEGRAM (Bạn điền trực tiếp hoặc dùng biến môi trường) ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "THAY_TOKEN_CUA_BAN_VAO_DAY";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "THAY_CHAT_ID_CUA_BAN_VAO_DAY";

if (!supabaseUrl || !supabaseKey) console.error("❌ LỖI: Thiếu SUPABASE_URL hoặc SUPABASE_KEY");

const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. BỘ TỪ ĐIỂN VIẾT TẮT (ĐÃ CẬP NHẬT ĐẦY ĐỦ THEO YÊU CẦU) ---
// Hệ thống sẽ tự động thay thế các từ này trước khi xử lý
const TU_DIEN_VIET_TAT = {
    "pmtl": "Pháp Môn Tâm Linh",
    "btpp": "Bạch Thoại Phật Pháp",
    "nnn": "Ngôi nhà nhỏ",
    "psv": "Phụng Sự Viên",
    "sh": "Sư Huynh",
    "kbt": "Kinh Bài Tập",
    "ps": "Phóng Sinh",
    "cđb": "Chú Đại Bi",
    "cdb": "Chú Đại Bi", 
    "tk": "Tâm Kinh",
    "lpdshv": "Lễ Phật Đại Sám Hối Văn",
    "vsc": "Vãng Sanh Chú",
    "cdbstc": "Công Đức Bảo Sơn Thần Chú",
    "cđbstc": "Công Đức Bảo Sơn Thần Chú",
    "nyblvdln": "Như Ý Bảo Luân Vương Đà La Ni",
    "bkcn": "Bổ Khuyết Chân Ngôn",
    "tpdtcn": "Thất Phật Diệt Tội Chân Ngôn",
    "qalccn": "Quán Âm Linh Cảm Chân Ngôn",
    "tvltqdqmvtdln": "Thánh Vô Lượng Thọ Quyết Định Quang Minh Vương Đà La Ni",
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

function cleanText(text) {
    if (!text) return "";
    let clean = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').replace(/\r\n/g, '\n');   
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
        if ((currentChunk.length + cleanP.length) < maxChunkSize) { currentChunk += (currentChunk ? "\n\n" : "") + cleanP; }
        else { if (currentChunk.length > 50) chunks.push(currentChunk); currentChunk = cleanP; }
    }
    if (currentChunk.length > 50) chunks.push(currentChunk);
    return chunks;
}

// --- 4. HỆ THỐNG CẢNH BÁO TELEGRAM (MỚI) ---
async function sendTelegramAlert(message) {
    // Nếu chưa cấu hình thì bỏ qua
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || TELEGRAM_TOKEN.includes("THAY_TOKEN")) return;
    
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        // Gửi tin nhắn
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: `🚨 <b>PSV ẢO VĂN TƯ TU</b> 🚨\n\n${message}`,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error("Không gửi được Telegram:", error.message);
    }
}

// --- 5. GỌI GEMINI ---
async function callGeminiAPI(payload, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) {
        // Gửi báo động nếu hết sạch Key
        await sendTelegramAlert("🆘 HẾT SẠCH API KEY GEMINI! Hệ thống không thể trả lời.");
        throw new Error("Hết Key Gemini.");
    }
    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.warn(`⚠️ Key ${currentIndex} bị 429. Đổi key...`);
            await sleep(1000);
            return callGeminiAPI(payload, currentIndex + 1, retryCount + 1);
        }
        throw error;
    }
}

// --- 6. AI EXTRACT KEYWORDS ---
async function aiExtractKeywords(userQuestion) {
    const prompt = `
    Nhiệm vụ: Bạn là chuyên gia tìm kiếm (SEO). Trích xuất "Từ khóa trọng tâm" từ câu hỏi.
    Yêu cầu: Bỏ từ giao tiếp, giữ danh từ/động từ chính. Trả về CHỈ TỪ KHÓA.
    Ví dụ: "ý nghĩa của việc phóng sinh là gì" -> phóng sinh ý nghĩa
    Input: "${userQuestion}"
    Output:
    `;
    try {
        const startIndex = getRandomStartIndex();
        const response = await callGeminiAPI({ contents: [{ parts: [{ text: prompt }] }] }, startIndex);
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().replace(/\n/g, " ") || userQuestion;
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

async function searchSupabaseContext(query) {
    try {
        const startIndex = getRandomStartIndex();
        const queryVector = await callEmbeddingWithRetry(query, startIndex);
        const { data, error } = await supabase.rpc('hybrid_search', {
            query_text: query, query_embedding: queryVector, match_count: 20, rrf_k: 60
        });
        if (error) throw error;
        return data && data.length > 0 ? data : null;
    } catch (error) {
        console.error("Lỗi tìm kiếm:", error.message);
        // Gửi báo động nếu lỗi Database
        await sendTelegramAlert(`❌ Lỗi Tìm Kiếm Supabase:\n${error.message}`);
        return null; 
    }
}

// --- 8. API CHAT (CÓ BÁO LỖI TELEGRAM) ---
app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        const fullQuestion = dichVietTat(question);
        const searchKeywords = await aiExtractKeywords(fullQuestion);
        
        console.log(`🗣️ User: "${question}" -> Key: "${searchKeywords}"`);

        const documents = await searchSupabaseContext(searchKeywords);

        if (!documents) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan: https://mucluc.pmtl.site" });
        }

        let contextString = "";
        documents.forEach((doc, index) => {
            contextString += `--- Nguồn #${index + 1} ---\nLink: ${doc.url}\nTiêu đề: ${doc.metadata?.title || 'No Title'}\nNội dung: ${doc.content.substring(0, 800)}...\n`;
        });

        const systemPrompt = `
        Bạn là Phụng Sự Viên Ảo.
        Câu hỏi gốc: "${fullQuestion}"
        Từ khóa trọng tâm: "${searchKeywords}"
        Dữ liệu tham khảo: ${contextString}
        Yêu cầu: Trả lời câu hỏi dựa trên bài viết khớp nhất với từ khóa. Cuối câu trả lời DÁN LINK GỐC.
        `;

        const startIndex = getRandomStartIndex();
        const response = await callGeminiAPI({ contents: [{ parts: [{ text: systemPrompt }] }] }, startIndex);

        let aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, đệ chưa nghĩ ra câu trả lời.";
        res.json({ answer: "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        // BÁO LỖI VỀ TELEGRAM
        await sendTelegramAlert(`❌ LỖI API CHAT:\nUser: ${req.body.question}\nError: ${error.message}`);
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

// --- API 2: KIỂM TRA & XÓA (PHIÊN BẢN ĐẶC TRỊ BLOGGER SOFT 404) ---
app.post('/api/admin/check-batch', async (req, res) => {
    const { password, urls } = req.body;

    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: "Thiếu danh sách URL" });

    const results = { checked: 0, deleted: 0, errors: 0, logs: [] };

    try {
        for (const url of urls) {
            try {
                // Tải nội dung trang web (Timeout 10s)
                const response = await axios.get(url, { 
                    timeout: 10000, 
                    validateStatus: status => status < 500 
                });
                
                let isDeadLink = false;
                let reason = "";

                // TRƯỜNG HỢP 1: Lỗi 404 chuẩn (ít gặp ở Blogger, nhưng vẫn check)
                if (response.status === 404) {
                    isDeadLink = true;
                    reason = "HTTP 404";
                } 
                // TRƯỜNG HỢP 2: Soft 404 (Trạng thái 200 nhưng hiện thông báo lỗi)
                else if (response.status === 200) {
                    let html = response.data;
                    
                    if (typeof html === 'string') {
                        // --- BƯỚC QUAN TRỌNG NHẤT: CHUẨN HÓA HTML ---
                        // 1. Chuyển về chữ thường
                        // 2. Thay thế tất cả xuống dòng, tab, khoảng trắng kép thành 1 khoảng trắng đơn
                        const cleanHtml = html.toLowerCase().replace(/\s+/g, ' ');

                        // --- CÁC CÂU BÁO LỖI ĐẶC TRƯNG CỦA BLOGGER ---
                        // Lưu ý: Viết chữ thường, không dấu câu thừa
                        const errorPhrases = [
                            "rất tiếc, trang bạn đang tìm trong blog này không tồn tại", // Tiếng Việt
                            "sorry, the page you were looking for in this blog does not exist", // Tiếng Anh
                            "không tìm thấy trang", // Tiêu đề thường gặp
                            "page not found"
                        ];

                        // Kiểm tra xem HTML đã chuẩn hóa có chứa câu nào không
                        for (const phrase of errorPhrases) {
                            if (cleanHtml.includes(phrase)) {
                                isDeadLink = true;
                                reason = `Phát hiện câu: "${phrase.substring(0, 20)}..."`;
                                break; // Tìm thấy 1 lỗi là đủ
                            }
                        }
                    }
                }

                // XỬ LÝ XÓA
                if (isDeadLink) {
                    const { error: delError } = await supabase
                        .from('vn_buddhism_content')
                        .delete()
                        .eq('url', url);

                    if (!delError) {
                        results.deleted++;
                        results.logs.push(`🗑️ Đã xóa (${reason}): ${url}`);
                    } else {
                        results.errors++;
                        results.logs.push(`⚠️ Lỗi xóa DB: ${url}`);
                    }
                } else {
                    results.checked++;
                }

            } catch (err) {
                // Lỗi mạng hoặc lỗi khác -> Không xóa để an toàn
                results.errors++;
            }
            
            // Nghỉ nhẹ 50ms
            await sleep(50);
        }
        res.json(results);

    } catch (error) {
        res.status(500).json({ error: error.message });
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

// --- API TEST TELEGRAM (Dùng để kiểm tra kết nối) ---
app.get('/api/test-telegram', async (req, res) => {
    try {
        await sendTelegramAlert("🚀 <b>Test thành công!</b>\nServer của Sư huynh đã kết nối được với Telegram.\n\nChúc Sư huynh một ngày an lạc! 🙏");
        res.json({ success: true, message: "Đã gửi tin nhắn. Sư huynh kiểm tra điện thoại nhé!" });
    } catch (error) {
        res.status(500).json({ error: "Lỗi gửi Telegram: " + error.message });
    }
});

// --- API XÓA BÀI VIẾT (THEO URL) ---
app.post('/api/admin/delete-post', async (req, res) => {
    const { password, url } = req.body;

    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu Admin!" });
    if (!url) return res.status(400).json({ error: "Thiếu URL bài viết cần xóa!" });

    try {
        // Xóa tất cả các đoạn (chunks) có cùng URL này
        const { error, count } = await supabase
            .from('vn_buddhism_content')
            .delete({ count: 'exact' }) // Đếm số dòng bị xóa
            .eq('url', url);

        if (error) throw error;

        if (count === 0) {
            return res.json({ success: false, message: "Không tìm thấy bài viết này trong Database." });
        }

        res.json({ success: true, message: `Đã xóa vĩnh viễn bài viết (Gồm ${count} đoạn dữ liệu).` });

    } catch (error) {
        console.error("Lỗi xóa bài:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
