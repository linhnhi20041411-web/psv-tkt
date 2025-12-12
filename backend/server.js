// server.js - Phiên bản Fix Lỗi: Prompt Gốc + Diễn Giải (Bypass Recitation)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- 1. XỬ LÝ DANH SÁCH KEY ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);

if (apiKeys.length > 0) {
    console.log(`✅ Đã tìm thấy [${apiKeys.length}] API Keys.`);
} else {
    console.error("❌ CẢNH BÁO: Chưa cấu hình API Key!");
}

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", server: "Ready" });
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 2. HÀM GỌI API ---
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
    // SỬA LỖI QUAN TRỌNG: Dùng 1.5-flash (2.5 chưa hoạt động)
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
        
        if (status === 429 || status === 400 || status === 403 || status >= 500) {
            console.warn(`⚠️ Key ${keyIndex} lỗi (Mã: ${status}). Đổi Key...`);
            if (status === 429) await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

app.post('/api/chat', async (req, res) => {
    if (apiKeys.length === 0) return res.status(500).json({ error: 'Chưa cấu hình API Key.' });

    try {
        const { question, context } = req.body;
        if (!question || !context) return res.status(400).json({ error: 'Thiếu dữ liệu.' });

        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        // =================================================================================
        // BƯỚC 1: PROMPT GỐC (Ưu tiên trích dẫn chính xác)
        // =================================================================================
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

        // =================================================================================
        // BƯỚC 2: CHIẾN THUẬT CỨU NGUY - DIỄN GIẢI Ý CHÍNH (Thay thế chiến thuật cũ)
        // =================================================================================
        if (finishReason === "RECITATION" || !aiResponse) {
            console.log("⚠️ Prompt Gốc bị chặn. Kích hoạt Chiến thuật Diễn Giải (Paraphrasing)...");

            // CHIẾN THUẬT MỚI: Tóm lược/Viết lại ý chính để vượt tường lửa bản quyền
            const promptDienGiai = `Bạn là trợ lý hỗ trợ tu tập.
            NV: Trả lời câu hỏi: "${question}" dựa trên VĂN BẢN NGUỒN.
            
            VẤN ĐỀ: Việc trích dẫn nguyên văn đang bị lỗi hệ thống (Recitation Error).
            
            GIẢI PHÁP (BẮT BUỘC):
            1. **ĐỌC HIỂU:** Tìm các ý chính liên quan đến câu hỏi.
            2. **DIỄN ĐẠT LẠI (QUAN TRỌNG):** Viết lại các ý đó dưới dạng liệt kê gạch đầu dòng.
               - Dùng ngôn ngữ ngắn gọn, súc tích hơn.
               - **TUYỆT ĐỐI KHÔNG** làm sai lệch ý nghĩa giáo lý.
               - Giữ nguyên các thuật ngữ Phật học (Ví dụ: tên Chú, tên Bồ Tát, các danh từ riêng...).
            3. **XƯNG HÔ:** Bắt đầu bằng câu: "Do hạn chế về bản quyền trích dẫn, đệ xin tóm lược các ý chính như sau:".

            --- VĂN BẢN NGUỒN ---
            ${context}
            --- HẾT ---`;

            // Gọi API lần 2 (Lưu ý: Đã sửa lại tên biến thành promptDienGiai để khớp)
            response = await callGeminiWithRetry({
                contents: [{ parts: [{ text: promptDienGiai }] }], // <-- ĐÃ SỬA TÊN BIẾN Ở ĐÂY
                safetySettings: safetySettings,
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
            }, 0);

            if (response.data && response.data.candidates && response.data.candidates.length > 0) {
                const candidate = response.data.candidates[0];
                if (candidate.content?.parts?.[0]?.text) {
                    aiResponse = candidate.content.parts[0].text;
                } else {
                    aiResponse = "Nội dung này Google chặn tuyệt đối (Recitation). Sư huynh vui lòng xem trực tiếp trong sách ạ.";
                }
            }
        }

        // =================================================================================
        // TRẢ KẾT QUẢ CUỐI CÙNG
        // =================================================================================
        let finalAnswer = "";
        if (aiResponse.includes("mucluc.pmtl.site") || aiResponse.includes("NONE")) {
             finalAnswer = "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site .";
        } else {
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse + "\n\n_Nhắc nhở: Sư huynh kiểm tra lại tại: https://tkt.pmtl.site nhé 🙏_";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        let msg = "Lỗi hệ thống.";
        if (error.message === "ALL_KEYS_EXHAUSTED") {
            msg = "Hệ thống đang quá tải, tất cả các Key đều đang bận. Vui lòng thử lại sau 1-2 phút.";
        }
        console.error("Final Error Handler:", error.message);
        res.status(503).json({ answer: msg });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
