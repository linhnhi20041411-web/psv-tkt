// server.js - Phiên bản Fix Lỗi Link & Hạ Ngưỡng Tìm Kiếm

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
    // Dùng Flash 2.0 hoặc 1.5-flash
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
            if (status === 429) await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

// --- HÀM TÌM KIẾM SUPABASE (ĐÃ ĐIỀU CHỈNH) ---
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
            match_threshold: 0.3, // <--- SỬA: Hạ xuống 0.3 để tìm dễ hơn
            match_count: 5
        });

        if (error) {
            console.error("Lỗi RPC:", error);
            throw error;
        }

        // Log để kiểm tra xem tìm được bao nhiêu dòng
        console.log(`🔍 Tìm thấy ${data ? data.length : 0} kết quả trong DB.`);

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

        console.log(`USER HỎI: "${question}"`);
        
        // 1. Tìm kiếm Supabase
        const searchResult = await searchSupabaseContext(question);

        // --- XỬ LÝ KHI KHÔNG TÌM THẤY (SỬA LỖI LINK CHẾT) ---
        if (!searchResult) {
            console.log("⚠️ Không tìm thấy dữ liệu phù hợp trong DB.");
            // Trả về HTML link trực tiếp để đảm bảo bấm được
            return res.json({ 
                answer: `Đệ tìm trong dữ liệu không thấy thông tin này.<br><br>Mời Sư huynh tra cứu thêm tại mục lục tổng quan:<br><a href="https://mucluc.pmtl.site" target="_blank" style="color:#2563eb; text-decoration:underline; font-weight:bold;">👉 https://mucluc.pmtl.site</a>` 
            });
        }

        const context = searchResult.text;
        const sourceUrl = searchResult.url; 

        // 2. Gọi Gemini
        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        const promptGoc = `Bạn là một công cụ trích xuất thông tin.
        QUY TẮC:
        1. Chỉ trả lời dựa vào VĂN BẢN NGUỒN.
        2. Nếu không có thông tin, trả lời: "NONE".
        3. Xưng hô: "đệ" và "Sư huynh".
        4. Trả lời ngắn gọn.
        
        --- NGUỒN ---
        ${context}
        --- HẾT ---
        
        Câu hỏi: ${question}
        Câu trả lời:`;

        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            safetySettings: safetySettings,
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        }, 0);

        let aiResponse = "";
        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            aiResponse = response.data.candidates[0].content.parts[0].text;
        }

        // Xử lý Recitation hoặc không có đáp án
        if (!aiResponse || aiResponse.includes("NONE")) {
             // Fallback sang diễn giải
             const promptDienGiai = `Tóm tắt ý chính trả lời cho câu hỏi: "${question}" dựa trên: \n${context}`;
             response = await callGeminiWithRetry({
                contents: [{ parts: [{ text: promptDienGiai }] }],
                generationConfig: { temperature: 0.3 }
             }, 0);
             if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = response.data.candidates[0].content.parts[0].text;
            }
        }

        // 3. Ghép kết quả và Nút Xem Thêm
        let finalAnswer = "";
        
        // Kiểm tra lại lần nữa nếu AI vẫn trả lời NONE
        if (aiResponse.includes("NONE") || aiResponse.length < 5) {
             finalAnswer = `Đệ tìm thấy bài viết liên quan nhưng AI chưa trích xuất được. Sư huynh vui lòng xem trực tiếp ạ.`;
        } else {
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse;
        }

        // Luôn luôn hiện nút nếu có Link
        if (sourceUrl && sourceUrl.startsWith('http')) {
            finalAnswer += `\n\n<br><a href="${sourceUrl}" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 20px; border-radius:20px; text-decoration:none; font-weight:bold; margin-top:10px; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">👉 Xem Thêm Chi Tiết</a>`;
        } else {
             finalAnswer += `\n\n<br>_Nguồn: Kho tàng thư_`;
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
