// server.js - Phiên bản Debug & Nới Lỏng Prompt

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

// --- CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ LỖI: Chưa cấu hình SUPABASE_URL hoặc SUPABASE_KEY");
}
const supabase = createClient(supabaseUrl, supabaseKey);

// --- HÀM HỖ TRỢ ---
function getRandomKey() {
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        throw new Error("ALL_KEYS_EXHAUSTED");
    }
    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash-lite"; 
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
            if (status === 429) await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

// --- HÀM 1: TỐI ƯU HÓA CÂU HỎI ---
async function optimizeQuery(originalQuestion) {
    try {
        // Prompt đơn giản hóa để tránh lỗi
        const prompt = `Viết lại câu: "${originalQuestion}" dùng từ ngữ Phật học chính xác hơn. Chỉ trả về câu mới.`;
        
        const response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1 }
        }, 0);

        const newQuery = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        return newQuery || originalQuestion;
    } catch (e) {
        return originalQuestion; 
    }
}

// --- HÀM 2: TÌM KIẾM SUPABASE ---
async function searchSupabaseContext(query) {
    try {
        if (!supabaseUrl || !supabaseKey) return null;
        
        const genAI = new GoogleGenerativeAI(getRandomKey());
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        
        const result = await model.embedContent(query);
        const queryVector = result.embedding.values;

        // Gọi hàm RPC
        const { data, error } = await supabase.rpc('match_documents', {
            query_embedding: queryVector,
            match_threshold: 0.20, // Hạ cực thấp để vơ vét dữ liệu
            match_count: 8         // Tăng số lượng đoạn văn lấy về
        });

        if (error) throw error;

        console.log(`   -> Tìm kiếm "${query}" ra ${data ? data.length : 0} kết quả.`);

        if (!data || data.length === 0) return null;

        const topUrl = data[0].url; 
        const contextText = data.map(doc => doc.content).join("\n\n---\n\n");

        return { text: contextText, url: topUrl };

    } catch (error) {
        console.error("Lỗi tìm kiếm Supabase:", error);
        return null; 
    }
}

app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        console.log(`\n=== USER HỎI: "${question}" ===`);
        
        // 1. Tối ưu câu hỏi
        const optimizedQuestion = await optimizeQuery(question);
        console.log(`🔄 Bot hiểu là: "${optimizedQuestion}"`);

        // 2. Tìm kiếm
        const searchResult = await searchSupabaseContext(optimizedQuestion);

        // --- XỬ LÝ KHI KHÔNG TÌM THẤY ---
        if (!searchResult) {
            console.log("❌ Không tìm thấy dữ liệu nào.");
            return res.json({ 
                answer: `Đệ tìm không thấy thông tin này trong kho dữ liệu.<br><br>Sư huynh thử tra cứu tại: <a href="https://mucluc.pmtl.site" target="_blank">mucluc.pmtl.site</a>` 
            });
        }

        const context = searchResult.text;
        const sourceUrl = searchResult.url; 

        // ⚠️ LOG QUAN TRỌNG: Xem Supabase trả về cái gì?
        // Bạn hãy nhìn vào Terminal (Logs) xem đoạn text này có chứa câu trả lời không?
        console.log("------------------------------------------------");
        console.log("CONTEXT GỬI CHO GEMINI (Trích đoạn):");
        console.log(context.substring(0, 300) + "..."); // Chỉ in 300 ký tự đầu để kiểm tra
        console.log("------------------------------------------------");

        // 3. Gọi Gemini (PROMPT MỚI DỄ TÍNH HƠN)
        const promptGoc = `Bạn là trợ lý ảo Phật giáo.
        
        Dữ liệu tham khảo:
        ---
        ${context}
        ---

        Câu hỏi của người dùng: "${question}" (Ý hiểu: ${optimizedQuestion})

        YÊU CẦU:
        1. Trả lời câu hỏi dựa trên Dữ liệu tham khảo.
        2. Nếu dữ liệu chỉ chứa tiêu đề hoặc câu hỏi tương tự mà không có câu trả lời rõ ràng: Hãy tự suy luận dựa trên kiến thức Phật học của bạn nhưng phải nói rõ "Theo kiến thức Phật học thường thức...".
        3. Tuyệt đối không trả lời "Không tìm thấy" nếu bài viết có liên quan đến chủ đề.
        4. Trả lời ngắn gọn, xưng hô "đệ" và "Sư huynh".

        Câu trả lời:`;

        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            generationConfig: { temperature: 0.3 } // Tăng sáng tạo lên xíu
        }, 0);

        let aiResponse = "";
        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            aiResponse = response.data.candidates[0].content.parts[0].text;
        }

        let finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse;

        if (sourceUrl && sourceUrl.startsWith('http')) {
            finalAnswer += `\n\n<br><a href="${sourceUrl}" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 20px; border-radius:20px; text-decoration:none; font-weight:bold; margin-top:10px;">👉 Xem Thêm Chi Tiết</a>`;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi:", error);
        res.status(500).json({ error: "Lỗi hệ thống." });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
