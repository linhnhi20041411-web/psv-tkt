// server.js - Phiên bản Tối ưu cho Gemini 1.5 Flash + Smart RAG Data
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

const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. HÀM TÌM KIẾM (Đã tinh chỉnh cho dữ liệu mới) ---
async function searchSupabaseContext(query) {
    try {
        // 1. Tạo Vector như cũ
        const genAI = new GoogleGenerativeAI(apiKeys[0]); 
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        
        const result = await model.embedContent(query);
        const queryVector = result.embedding.values;

        // 2. GỌI HÀM HYBRID MỚI
        // Lưu ý: Đã thêm tham số `query_text: query`
        const { data, error } = await supabase.rpc('match_documents', {
            query_embedding: queryVector,
            query_text: query,  // <--- Gửi thêm câu hỏi gốc xuống DB
            match_threshold: 0.1, // Giữ mức thấp an toàn
            match_count: 25
        });

        if (error) {
            console.error("❌ Lỗi Supabase RPC:", error);
            return null;
        }

        if (!data || data.length === 0) return null;

        // Log kiểm tra xem nó tìm bằng cách nào (Điểm > 1 là tìm bằng từ khóa)
        console.log("🔍 Kết quả Hybrid:", data.map(d => ({ 
            id: d.id, 
            score: d.similarity, // Nếu score = 1.5 tức là tìm thấy nhờ từ khóa!
            preview: d.content.substring(0, 30) 
        })));

        const topUrl = data[0].url; 
        const contextText = data.map(doc => doc.content).join("\n\n---\n\n");

        return { text: contextText, url: topUrl };

    } catch (error) {
        console.error("Lỗi tìm kiếm:", error);
        return null; 
    }
}

// --- 3. HÀM GỌI GEMINI (Retry Logic) ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) keyIndex = 0; // Quay vòng key nếu hết
    if (retryCount > 3) throw new Error("GEMINI_OVERLOAD");

    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash"; // Dùng bản Flash mới nhất
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 
        });
        return response;
    } catch (error) {
        const status = error.response ? error.response.status : 0;
        console.warn(`⚠️ Lỗi Gemini (Key ${keyIndex}, Status ${status}). Đổi key/Thử lại...`);
        
        if (status === 429) await sleep(2000); // Quá tải thì nghỉ 2s
        return callGeminiWithRetry(payload, keyIndex + 1, retryCount + 1);
    }
}

// --- 4. API CHAT ---
app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        console.log(`\n💬 Câu hỏi: "${question}"`);
        
        // 1. Tìm kiếm dữ liệu
        const searchResult = await searchSupabaseContext(question);

        // Biến lưu kết quả cuối cùng
        let aiResponse = "";
        let sourceUrl = "";
        let hasData = false;

        if (searchResult) {
            hasData = true;
            sourceUrl = searchResult.url;
            const context = searchResult.text;

            // 2. Prompt cho Gemini (Dành cho dữ liệu RAG)
            const prompt = `Bạn là trợ lý ảo hỗ trợ Phật Pháp (Pháp Môn Tâm Linh).
            
            NHIỆM VỤ: Trả lời câu hỏi dựa trên "DỮ LIỆU THAM KHẢO" bên dưới.
            
            QUY TẮC:
            1. Chỉ dùng thông tin trong DỮ LIỆU THAM KHẢO. Không bịa đặt.
            2. Nếu dữ liệu có chứa câu trả lời trực tiếp (ví dụ: Sư phụ đáp...), hãy ưu tiên trích dẫn ý đó.
            3. Trình bày ngắn gọn, gạch đầu dòng rõ ràng.
            4. Giọng điệu: Khiêm cung, xưng "đệ" - gọi "Sư huynh".
            
            --- DỮ LIỆU THAM KHẢO ---
            ${context}
            --------------------------
            
            CÂU HỎI: ${question}
            TRẢ LỜI:`;

            const geminiRes = await callGeminiWithRetry({
                contents: [{ parts: [{ text: prompt }] }]
            });

            if (geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = geminiRes.data.candidates[0].content.parts[0].text;
            }
        }

        // 3. Xử lý hiển thị kết quả
        let finalAnswer = "";

        // Nếu không tìm thấy dữ liệu HOẶC AI bảo không biết
        if (!hasData || aiResponse.includes("không có thông tin") || aiResponse.length < 10) {
             finalAnswer = "Đệ chưa tìm thấy nội dung chi tiết trong kho dữ liệu hiện tại. Mời Sư huynh tra cứu thêm tại mục lục tổng quan:";
             // Nút XEM THÊM (Mục lục)
             finalAnswer += `<br><div style="margin-top: 15px;"><a href="https://mucluc.pmtl.site" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 25px; border-radius:30px; text-decoration:none; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2); transition: all 0.3s; font-family: sans-serif;">🔍 XEM THÊM</a></div>`;
        } 
        else {
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse;

            // Nút ĐỌC KHAI THỊ (Link gốc)
            if (sourceUrl && sourceUrl.startsWith('http')) {
                finalAnswer += `<br><div style="margin-top: 15px;"><a href="${sourceUrl}" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 25px; border-radius:30px; text-decoration:none; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2); transition: all 0.3s; font-family: sans-serif;">📖 Đọc Khai Thị</a></div>`;
            } else {
                finalAnswer += "\n\n_Dữ liệu trích xuất từ kho tàng thư._";
            }
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi Server:", error);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
