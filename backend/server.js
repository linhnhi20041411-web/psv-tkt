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

// --- CÁC API ADMIN (GIỮ NGUYÊN CODE CŨ CỦA BẠN - KHÔNG THAY ĐỔI) ---
// (Copy lại phần Admin: sync-blogger, check-batch, manual-add...)
// ... Bạn giữ nguyên phần Admin ở các câu trả lời trước nhé ...

// Test Telegram
app.get('/api/test-telegram', async (req, res) => {
    try { await sendTelegramAlert("🚀 Test Telegram OK!"); res.json({success:true}); } 
    catch(e){ res.status(500).json({error:e.message}); }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
