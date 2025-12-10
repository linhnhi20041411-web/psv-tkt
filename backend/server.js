// server.js - Phiên bản Tích hợp Supabase RAG + Nút Xem Thêm (Link Source)

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

app.get('/api/test-db', async (req, res) => {
    try {
        // Thử lấy 1 dòng dữ liệu từ bảng 'vn_buddhism_content' (hoặc bảng 'articles')
        // Lưu ý: Thay tên bảng cho đúng với bảng thực tế huynh đang có
        const { data, error } = await supabase
            .from('vn_buddhism_content') 
            .select('*')
            .limit(1);

        if (error) throw error;

        res.json({ 
            status: "✅ KẾT NỐI THÀNH CÔNG", 
            message: "Render đã đọc được dữ liệu từ Supabase",
            data_preview: data 
        });

    } catch (err) {
        console.error("Lỗi kết nối Supabase:", err);
        res.status(500).json({ 
            status: "❌ KẾT NỐI THẤT BẠI", 
            error_message: err.message,
            hint: "Kiểm tra lại SUPABASE_URL và SUPABASE_KEY trong phần Environment của Render."
        });
    }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 2. HÀM HỖ TRỢ: LẤY KEY NGẪU NHIÊN ---
function getRandomKey() {
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

// --- 3. HÀM MỚI: TÌM KIẾM CONTEXT TỪ SUPABASE (ĐÃ SỬA ĐỂ LẤY URL) ---
async function searchSupabaseContext(query) {
    try {
        if (!supabaseUrl || !supabaseKey) return null; // Sửa thành null để dễ check
        
        // Dùng SDK để tạo Embedding cho câu hỏi
        const genAI = new GoogleGenerativeAI(getRandomKey());
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        
        const result = await model.embedContent(query);
        const queryVector = result.embedding.values;

        // Gọi hàm RPC trong Supabase
        const { data, error } = await supabase.rpc('match_documents', {
            query_embedding: queryVector,
            match_threshold: 0.25, 
            match_count: 20 
        });

        // Ngay sau đoạn gọi rpc ở trên:
        
        if (error) {
            console.error("❌ Lỗi Supabase:", error);
        } else {
            // In ra kết quả để xem máy chấm bao nhiêu điểm
            console.log("✅ Kết quả tìm kiếm:", data.map(item => ({
                id: item.id,
                similarity: item.similarity, // <--- Quan trọng: Xem điểm số ở đây
                content_preview: item.content ? item.content.substring(0, 50) + "..." : "No content"
            })));
        }
        
        if (!data || data.length === 0) return null;
        
        if (error) throw error;

        if (!data || data.length === 0) return null;

        // --- CẬP NHẬT MỚI: Lấy URL của kết quả đầu tiên ---
        const topUrl = data[0].url; 

        // Ghép các đoạn văn tìm được thành 1 chuỗi context
        const contextText = data.map(doc => doc.content).join("\n\n---\n\n");

        // Trả về Object chứa cả Text và URL
        return { text: contextText, url: topUrl };

    } catch (error) {
        console.error("Lỗi tìm kiếm Supabase:", error);
        return null; 
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
    try {
        const { question } = req.body; 
        
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        console.log(`🔍 Đang tìm dữ liệu cho: "${question}"`);
        
        // --- CẬP NHẬT MỚI: Xử lý kết quả trả về từ Supabase ---
        const searchResult = await searchSupabaseContext(question);

        if (!searchResult) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site ." });
        }

        // Tách Text và URL ra
        const context = searchResult.text;
        const sourceUrl = searchResult.url; 

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

        // --- CẬP NHẬT MỚI: SỬA LỖI HIỂN THỊ HTML ---
        let finalAnswer = "";

        // TRƯỜNG HỢP 1: Không tìm thấy kết quả -> Nút XEM THÊM (Viết liền 1 dòng)
        if (aiResponse.includes("mucluc.pmtl.site") || aiResponse.includes("NONE")) {
             finalAnswer = "Đệ chưa tìm thấy nội dung chi tiết trong kho dữ liệu hiện tại. Mời Sư huynh tra cứu thêm tại mục lục tổng quan:";
             
             // Code nút bấm viết liền, không xuống dòng
             finalAnswer += `<br><div style="margin-top: 15px;"><a href="https://mucluc.pmtl.site" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 25px; border-radius:30px; text-decoration:none; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2); transition: all 0.3s; font-family: sans-serif;">🔍 XEM THÊM</a></div>`;
        } 
        
        // TRƯỜNG HỢP 2: Tìm thấy kết quả -> Nút ĐỌC KHAI THỊ (Viết liền 1 dòng)
        else {
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse;

            if (sourceUrl && sourceUrl.startsWith('http')) {
                // Code nút bấm viết liền, không xuống dòng
                finalAnswer += `<br><div style="margin-top: 15px;"><a href="${sourceUrl}" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 25px; border-radius:30px; text-decoration:none; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2); transition: all 0.3s; font-family: sans-serif;">📖 Đọc Khai Thị</a></div>`;
            } else {
                finalAnswer += "\n\n_Dữ liệu trích xuất từ kho tàng thư._";
            }
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
