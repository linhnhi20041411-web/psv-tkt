// server.js - Phiên bản Fix Lỗi Semantic Search & Model Version
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

// Hàm lấy key ngẫu nhiên để san sẻ tải cho Embedding
function getRandomKey() {
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

async function searchSupabaseContext(query) {
    try {
        // --- SỬA ĐỔI: Dùng Key ngẫu nhiên thay vì key đầu tiên ---
        const genAI = new GoogleGenerativeAI(getRandomKey()); 
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        
        // Tạo vector cho tìm kiếm
        const result = await model.embedContent({
            content: { parts: [{ text: query }] },
            taskType: "RETRIEVAL_QUERY" 
        });
        const queryVector = result.embedding.values;

        // GỌI HÀM HYBRID
        const { data, error } = await supabase.rpc('match_documents', {
            query_embedding: queryVector,
            query_text: query,      
            match_threshold: 0.15,  
            match_count: 20         
        });

        if (error) {
            console.error("❌ Lỗi Supabase:", error);
            // Nếu lỗi RPC (Database), ta có thể return null hoặc throw
            return null;
        }

        if (!data || data.length === 0) return null;

        // ... (Phần xử lý kết quả giữ nguyên) ...
        const topUrl = data[0].url; 
        const contextText = data.map(doc => doc.content).join("\n\n---\n\n");
        return { text: contextText, url: topUrl };

    } catch (error) {
        // Nếu lỗi Embedding (do Key hết hạn), ta có thể thử lại đệ quy đơn giản
        if (error.message.includes('429')) {
             console.warn("⚠️ Embedding bị 429, đang thử lại với key khác...");
             // Tạm nghỉ 1s rồi gọi lại chính nó (sẽ random ra key mới)
             await new Promise(r => setTimeout(r, 1000));
             return searchSupabaseContext(query);
        }
        console.error("Lỗi tìm kiếm:", error);
        return null; 
    }
}

// --- 3. HÀM GỌI GEMINI (Đã sửa tên Model) ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) keyIndex = 0; 
    if (retryCount > 3) throw new Error("GEMINI_OVERLOAD");

    const currentKey = apiKeys[keyIndex];
    
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
        console.warn(`⚠️ Lỗi Gemini (Key ${keyIndex}, Status ${status}). Đổi key/Thử lại...`);
        
        if (status === 429) await sleep(2000); 
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

        let aiResponse = "";
        let sourceUrl = "";
        let hasData = false;

        if (searchResult) {
            hasData = true;
            sourceUrl = searchResult.url;
            const context = searchResult.text;

            // Prompt được tối ưu lại để Gemini xử lý dữ liệu tốt hơn
            const prompt = `Bạn là trợ lý ảo hỗ trợ Phật Pháp (Pháp Môn Tâm Linh).
            
            DỮ LIỆU THAM KHẢO (Đã được lọc từ kho tàng thư):
            --------------------------
            ${context}
            --------------------------
            
            YÊU CẦU:
            1. Trả lời câu hỏi: "${question}" dựa trên dữ liệu trên.
            2. Nếu câu hỏi dùng từ ngữ khác (ví dụ "buổi tối") nhưng dữ liệu có từ đồng nghĩa ("ban đêm"), hãy tự hiểu và trích dẫn.
            3. Nếu tìm thấy câu trả lời trực tiếp, hãy trích nguyên văn lời Sư Phụ.
            4. Nếu không có thông tin liên quan trong dữ liệu, hãy trả lời: "NONE".
            
            TRẢ LỜI:`;

            const geminiRes = await callGeminiWithRetry({
                contents: [{ parts: [{ text: prompt }] }]
            });

            if (geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = geminiRes.data.candidates[0].content.parts[0].text;
            }
        }

        // 3. Xử lý hiển thị
        let finalAnswer = "";

        if (!hasData || aiResponse.includes("NONE") || aiResponse.length < 5) {
             finalAnswer = "Đệ chưa tìm thấy nội dung chi tiết trong kho dữ liệu hiện tại. Mời Sư huynh tra cứu thêm tại mục lục tổng quan:";
             finalAnswer += `<br><div style="margin-top: 15px;"><a href="https://mucluc.pmtl.site" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 25px; border-radius:30px; text-decoration:none; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2); transition: all 0.3s; font-family: sans-serif;">🔍 XEM THÊM</a></div>`;
        } 
        else {
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse;
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
