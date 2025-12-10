// server.js - Phiên bản Hybrid Search: Vector + Keyword (Chính xác tuyệt đối)

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

// --- HÀM 1: PHÂN TÍCH & TRÍCH XUẤT TỪ KHÓA ---
async function analyzeQuery(originalQuestion) {
    try {
        // Yêu cầu AI vừa viết lại câu hỏi, vừa nhặt từ khóa quan trọng
        const prompt = `Bạn là chuyên gia tìm kiếm. 
        Nhiệm vụ: 
        1. Viết lại câu hỏi dùng thuật ngữ Phật học chính xác (Ví dụ: tối -> ban đêm, giết -> sát sanh).
        2. Trích xuất 2-3 từ khóa quan trọng nhất để tìm kiếm trong Database (Keywords).
        
        Trả về định dạng JSON thuần túy:
        {
          "rewritten": "câu hỏi đã viết lại",
          "keywords": ["từ khóa 1", "từ khóa 2"]
        }

        Câu gốc: "${originalQuestion}"`;

        const response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" } // Bắt buộc trả về JSON
        }, 0);

        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const result = JSON.parse(text);
        return result;

    } catch (e) {
        console.error("Lỗi phân tích query:", e.message);
        // Fallback nếu lỗi
        return { rewritten: originalQuestion, keywords: [] }; 
    }
}

// --- HÀM 2: TÌM KIẾM VECTOR (Theo ý nghĩa) ---
async function searchVector(query) {
    try {
        const genAI = new GoogleGenerativeAI(getRandomKey());
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        const result = await model.embedContent(query);
        const { data, error } = await supabase.rpc('match_documents', {
            query_embedding: result.embedding.values,
            match_threshold: 0.25, 
            match_count: 5
        });
        if (error) throw error;
        return data || [];
    } catch (e) {
        console.error("Lỗi Vector Search:", e.message);
        return [];
    }
}

// --- HÀM 3: TÌM KIẾM TỪ KHÓA (Theo chữ cái chính xác) ---
async function searchKeyword(keywords) {
    if (!keywords || keywords.length === 0) return [];
    try {
        console.log(`   -> Đang chạy Keyword Search với: ${JSON.stringify(keywords)}`);
        
        // Tạo query tìm kiếm: nội dung phải chứa TẤT CẢ từ khóa
        let query = supabase.from('vn_buddhism_content').select('content, url').limit(3);
        
        // Lặp qua từng từ khóa và thêm điều kiện ILIKE (Case insensitive)
        keywords.forEach(kw => {
            query = query.ilike('content', `%${kw}%`);
        });

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    } catch (e) {
        console.error("Lỗi Keyword Search:", e.message);
        return [];
    }
}

app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        console.log(`\n=== USER HỎI: "${question}" ===`);
        
        // 1. Phân tích câu hỏi
        const analysis = await analyzeQuery(question);
        console.log(`🔍 Phân tích: Rewritten="${analysis.rewritten}" | Keywords=${JSON.stringify(analysis.keywords)}`);

        // 2. Chạy SONG SONG cả 2 cách tìm kiếm (Hybrid Search)
        const [vectorResults, keywordResults] = await Promise.all([
            searchVector(analysis.rewritten),
            searchKeyword(analysis.keywords)
        ]);

        console.log(`   -> Vector tìm thấy: ${vectorResults.length} bài.`);
        console.log(`   -> Keyword tìm thấy: ${keywordResults.length} bài.`);

        // 3. Gộp kết quả (Ưu tiên Keyword lên đầu vì nó chính xác hơn)
        // Dùng Map để loại bỏ bài trùng lặp (dựa trên URL hoặc Content)
        const combinedMap = new Map();

        // Thêm kết quả Keyword trước
        keywordResults.forEach(item => combinedMap.set(item.url, item));
        // Thêm kết quả Vector sau (nếu chưa có)
        vectorResults.forEach(item => {
            if (!combinedMap.has(item.url)) combinedMap.set(item.url, item);
        });

        const finalData = Array.from(combinedMap.values()).slice(0, 8); // Lấy tối đa 8 bài

        // --- XỬ LÝ KHI KHÔNG TÌM THẤY ---
        if (finalData.length === 0) {
            console.log("❌ Không tìm thấy dữ liệu nào.");
            return res.json({ 
                answer: `Đệ tìm không thấy thông tin này trong kho dữ liệu.<br><br>Sư huynh thử tra cứu tại: <a href="https://mucluc.pmtl.site" target="_blank">mucluc.pmtl.site</a>` 
            });
        }

        // 4. Chuẩn bị Context
        // Lấy URL của bài đầu tiên (ưu tiên từ Keyword search)
        const topUrl = finalData[0].url; 
        const contextText = finalData.map(doc => doc.content).join("\n\n---\n\n");

        // 5. Gọi Gemini Trả lời
        const promptGoc = `Bạn là trợ lý ảo Phật giáo.
        
        Dữ liệu tham khảo (Được tìm thấy từ kho tàng thư):
        ---
        ${contextText}
        ---

        Câu hỏi: "${analysis.rewritten}"

        YÊU CẦU:
        1. Trả lời câu hỏi dựa trên Dữ liệu tham khảo. 
        2. Nếu tìm thấy bài viết đúng chủ đề, hãy tóm tắt ý chính của bài đó để trả lời.
        3. Nếu dữ liệu mâu thuẫn, hãy ưu tiên bài viết có chứa các từ khóa: ${analysis.keywords.join(", ")}.
        4. Trả lời ngắn gọn, xưng hô "đệ" - "Sư huynh".

        Câu trả lời:`;

        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            generationConfig: { temperature: 0.3 }
        }, 0);

        let aiResponse = "";
        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            aiResponse = response.data.candidates[0].content.parts[0].text;
        }

        let finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse;

        if (topUrl && topUrl.startsWith('http')) {
            finalAnswer += `\n\n<br><a href="${topUrl}" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 20px; border-radius:20px; text-decoration:none; font-weight:bold; margin-top:10px;">👉 Xem Thêm Chi Tiết</a>`;
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
