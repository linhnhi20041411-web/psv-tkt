// server.js - Phiên bản Tích hợp Supabase RAG

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- 1. CẤU HÌNH SUPABASE & API KEYS ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ LỖI: Chưa cấu hình SUPABASE_URL hoặc SUPABASE_KEY");
}
// Tạo client Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

if (apiKeys.length > 0) {
    console.log(`✅ Đã tìm thấy [${apiKeys.length}] API Keys.`);
} else {
    console.error("❌ CẢNH BÁO: Chưa cấu hình API Key!");
}

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", server: "Ready" });
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 2. HÀM HỖ TRỢ: LẤY KEY NGẪU NHIÊN ---
function getRandomKey() {
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

// --- 3. HÀM MỚI: TÌM KIẾM CONTEXT TỪ SUPABASE ---
async function searchSupabaseContext(query) {
    try {
        if (!supabaseUrl || !supabaseKey) return "";
        
        // Dùng SDK để tạo Embedding cho câu hỏi
        const genAI = new GoogleGenerativeAI(getRandomKey());
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        
        const result = await model.embedContent(query);
        const queryVector = result.embedding.values;

        // Gọi hàm RPC trong Supabase
        const { data, error } = await supabase.rpc('match_documents', {
            query_embedding: queryVector,
            match_threshold: 0.5, // Chỉ lấy độ chính xác > 50%
            match_count: 5        // Lấy 5 đoạn văn bản tốt nhất
        });

        if (error) throw error;

        if (!data || data.length === 0) return "";

        // Ghép các đoạn văn tìm được thành 1 chuỗi context
        return data.map(doc => doc.content).join("\n\n---\n\n");

    } catch (error) {
        console.error("Lỗi tìm kiếm Supabase:", error);
        return ""; 
    }
}

// --- 4. HÀM GỌI API GEMINI ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            console.log("🔁 Hết vòng Key, chờ 2s thử lại...");
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        throw new Error("ALL_KEYS_EXHAUSTED");
    }

    const currentKey = apiKeys[keyIndex];
    // Dùng Flash 2.0 (hoặc 1.5-flash tùy bạn chọn)
    const model = "gemini-2.0-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 
        });
        return response;
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

app.post('/api/chat', async (req, res) => {
    try {
        // --- ĐIỂM KHÁC BIỆT QUAN TRỌNG ---
        // Code cũ: const { question, context } = req.body;
        // Code mới: Chỉ lấy question
        const { question } = req.body; 
        
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        console.log(`🔍 Đang tìm dữ liệu cho: "${question}"`);
        
        // Tự tìm context từ Supabase
        const context = await searchSupabaseContext(question);

        if (!context) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site ." });
        }

        // --- CÁC PHẦN SAU GIỮ NGUYÊN ---
        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        const promptGoc = `Bạn là một công cụ trích xuất thông tin chính xác tuyệt đối. Nhiệm vụ của bạn là trích xuất câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

        **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI:**
        1.  **NGUỒN DỮ LIỆU DUY NHẤT:** Chỉ được phép sử dụng thông tin có trong phần "VĂN BẢN NGUỒN". TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài.
        2.  **CHIA NHỎ:** Không viết thành đoạn văn. Hãy tách từng ý quan trọng thành các gạch đầu dòng riêng biệt.          
        3.  **XỬ LÝ KHI KHÔNG TÌM THẤY:** Nếu thông tin không có trong văn bản nguồn, BẮT BUỘC trả lời chính xác câu: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site ."
        4.  **XƯNG HÔ:** Bạn tự xưng là "đệ" và gọi người hỏi là "Sư huynh".
        5.  **CHUYỂN ĐỔI NGÔI KỂ:** Chuyển "con/trò" thành "Sư huynh".
        6.  **XỬ LÝ LINK:** Trả về URL thuần túy, KHÔNG dùng Markdown link.
        7.  **PHONG CÁCH:** Trả lời NGẮN GỌN, SÚC TÍCH, đi thẳng vào vấn đề chính.
        
        --- VĂN BẢN NGUỒN BẮT ĐẦU ---
        ${context}
        --- VĂN BẢN NGUỒN KẾT THÚC ---
        
        Câu hỏi: ${question}
        Câu trả lời:`;

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

        if (finishReason === "RECITATION" || !aiResponse) {
            console.log("⚠️ Kích hoạt Chiến thuật Diễn Giải...");
            const promptDienGiai = `Bạn là trợ lý hỗ trợ tu tập.
            NV: Trả lời câu hỏi: "${question}" dựa trên VĂN BẢN NGUỒN.
            GIẢI PHÁP: Đọc hiểu và diễn đạt lại ý chính dưới dạng gạch đầu dòng. Không làm sai lệch ý nghĩa.
            XƯNG HÔ: Bắt đầu bằng: "Do hạn chế về bản quyền trích dẫn, đệ xin tóm lược các ý chính như sau:".

            --- VĂN BẢN NGUỒN ---
            ${context}
            --- HẾT ---`;

            response = await callGeminiWithRetry({
                contents: [{ parts: [{ text: promptDienGiai }] }],
                safetySettings: safetySettings,
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
            }, 0);

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = response.data.candidates[0].content.parts[0].text;
            } else {
                aiResponse = "Nội dung này Google chặn tuyệt đối (Recitation).";
            }
        }

        let finalAnswer = "";
        if (aiResponse.includes("mucluc.pmtl.site") || aiResponse.includes("NONE")) {
             finalAnswer = "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site .";
        } else {
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse + "\n\n_Nhắc nhở: Sư huynh kiểm tra lại tại: https://tkt.pmtl.site nhé 🙏_";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi:", error);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
