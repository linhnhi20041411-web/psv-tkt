// server.js - Phiên bản Hybrid Search RAG (Đã tối ưu cho Node.js)

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

// --- 1. CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) console.error("❌ LỖI: Thiếu SUPABASE_URL hoặc SUPABASE_KEY");
const supabase = createClient(supabaseUrl, supabaseKey);

function getRandomKey() {
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 2. HÀM TÌM KIẾM MỚI (HYBRID SEARCH) ---
async function searchSupabaseContext(query) {
    try {
        if (!supabaseUrl || !supabaseKey) return null;
        
        // Tạo Embedding cho câu hỏi
        const genAI = new GoogleGenerativeAI(getRandomKey());
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        
        const result = await model.embedContent(query);
        const queryVector = result.embedding.values;

        // Gọi hàm hybrid_search (Thay vì match_documents cũ)
        // Lưu ý: Không dùng threshold để tránh lọc mất kết quả tiềm năng
        const { data, error } = await supabase.rpc('hybrid_search', {
            query_text: query,              // Để tìm từ khóa
            query_embedding: queryVector,   // Để tìm ngữ nghĩa
            match_count: 10                 // Lấy 10 đoạn tốt nhất để Gemini lọc
        });

        if (error) {
            console.error("Lỗi Supabase RPC:", error);
            throw error;
        }

        if (!data || data.length === 0) return null;

        // Trả về danh sách đầy đủ để xử lý ở bước sau
        return data; 

    } catch (error) {
        console.error("Lỗi tìm kiếm:", error);
        return null; 
    }
}

// --- 3. GỌI GEMINI ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        throw new Error("ALL_KEYS_EXHAUSTED");
    }

    const currentKey = apiKeys[keyIndex];
    // Dùng Flash 2.0 cho nhanh và thông minh hơn
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 
        });
        return response;
    } catch (error) {
        const status = error.response ? error.response.status : 0;
        if (status === 429 || status >= 500) {
            console.warn(`⚠️ Key ${keyIndex} lỗi (Mã: ${status}). Đổi Key...`);
            await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        console.log(`🔍 User hỏi: "${question}"`);
        
        // 1. Tìm kiếm dữ liệu
        const documents = await searchSupabaseContext(question);

        if (!documents) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan: https://mucluc.pmtl.site" });
        }

        // 2. Xây dựng Context String thông minh (Kèm Link)
        // Chúng ta sẽ ghép Link ngay vào đoạn văn để Gemini biết trích dẫn
        let contextString = "";
        let primaryUrl = documents[0].url; // Lấy URL của bài khớp nhất làm nút "Xem thêm" chính

        documents.forEach((doc, index) => {
            contextString += `
            --- Nguồn tham khảo #${index + 1} ---
            Link gốc: ${doc.url || 'Không có link'}
            Nội dung: ${doc.content}
            `;
        });

        // 3. Prompt Engineering (Kỹ thuật ép trích dẫn)
        const systemPrompt = `
        Bạn là Phụng Sự Viên Ảo của trang "Tìm Khai Thị" (Pháp Môn Tâm Linh).
        
        NHIỆM VỤ: Trả lời câu hỏi của người dùng dựa trên "THÔNG TIN THAM KHẢO" bên dưới.
        
        QUY TẮC BẮT BUỘC:
        1. **Trung thực:** Chỉ dùng thông tin trong context. Nếu không có thông tin, hãy hướng dẫn người dùng vào trang mục lục (https://mucluc.pmtl.site).
        2. **Trích dẫn Link (QUAN TRỌNG):** - Sau mỗi ý hoặc đoạn thông tin lấy từ nguồn nào, bạn PHẢI để link nguồn đó ngay bên cạnh.
           - Ví dụ: "Niệm kinh cần tịnh tâm [Xem chi tiết](URL_NGUỒN)".
        3. **Văn phong:** Xưng "đệ", gọi "Sư huynh/Sư tỷ", khiêm cung, nhẹ nhàng.
        4. **Định dạng:** Dùng Markdown, gạch đầu dòng cho dễ đọc.

        --- THÔNG TIN THAM KHẢO ---
        ${contextString}
        --- HẾT THÔNG TIN ---

        Câu hỏi: ${question}
        Trả lời:
        `;

        const response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: systemPrompt }] }],
            generationConfig: { temperature: 0.3 }
        }, 0);

        let aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Fallback nếu Gemini không trả lời
        if (!aiResponse) {
             aiResponse = "Hiện tại đệ chưa kết nối được với kho dữ liệu. Sư huynh thử lại sau nhé.";
        }

        // 4. Xử lý kết quả trả về
        let finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse;
        
        // Thêm nút xem thêm (dẫn đến bài viết khớp nhất)
        if (primaryUrl && primaryUrl.startsWith('http')) {
             finalAnswer += `\n\n<br><a href="${primaryUrl}" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 20px; border-radius:20px; text-decoration:none; font-weight:bold; margin-top:10px; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">👉 Đọc Bài Viết Gốc Tốt Nhất</a>`;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi Server:", error);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
