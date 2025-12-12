const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Tăng giới hạn body để nhận dữ liệu lớn
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- 1. CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456"; 

if (!supabaseUrl || !supabaseKey) console.error("❌ LỖI: Thiếu SUPABASE_URL hoặc SUPABASE_KEY");

const supabase = createClient(supabaseUrl, supabaseKey);

// Hàm tiện ích: Lấy key ngẫu nhiên (chỉ dùng cho lần gọi đầu tiên)
function getRandomStartIndex() {
    return Math.floor(Math.random() * apiKeys.length);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 2. CÁC HÀM XỬ LÝ TEXT ---
function cleanText(text) {
    if (!text) return "";
    let clean = text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]*>?/gm, '') 
        .replace(/&nbsp;/g, ' ')
        .replace(/\r\n/g, '\n');   
    return clean.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

function chunkText(text, maxChunkSize = 2000) {
    if (!text) return [];
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = "";
    
    for (const p of paragraphs) {
        const cleanP = p.trim();
        if (!cleanP) continue;
        if ((currentChunk.length + cleanP.length) < maxChunkSize) {
            currentChunk += (currentChunk ? "\n\n" : "") + cleanP;
        } else {
            if (currentChunk.length > 50) chunks.push(currentChunk);
            currentChunk = cleanP;
        }
    }
    if (currentChunk.length > 50) chunks.push(currentChunk);
    return chunks;
}

// --- 3. LOGIC RETRY CHO EMBEDDING (MỚI THÊM) ---
async function callEmbeddingWithRetry(text, keyIndex = 0, retryCount = 0) {
    // Nếu đã thử hết các key trong danh sách
    if (retryCount >= apiKeys.length) {
        throw new Error("❌ Đã thử tất cả API Keys nhưng đều bị giới hạn (429) hoặc lỗi.");
    }

    // Xử lý vòng tròn index: Nếu keyIndex vượt quá độ dài mảng thì quay về 0
    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];

    try {
        const genAI = new GoogleGenerativeAI(currentKey);
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        
        const result = await model.embedContent(text);
        return result.embedding.values;

    } catch (error) {
        // Kiểm tra lỗi 429 từ SDK Google
        const isQuotaError = error.message?.includes('429') || error.status === 429 || error.message?.includes('quota');
        
        if (isQuotaError) {
            console.warn(`⚠️ Key ${currentIndex} bị 429 (Embedding). Đổi sang Key kế tiếp...`);
            await sleep(500); // Nghỉ nhẹ
            // Thử lại với key kế tiếp
            return callEmbeddingWithRetry(text, currentIndex + 1, retryCount + 1);
        }
        
        // Nếu lỗi khác (không phải quota), ném lỗi ra luôn
        throw error;
    }
}

// --- 4. HÀM TÌM KIẾM (ĐÃ CẬP NHẬT GỌI HÀM RETRY) ---
async function searchSupabaseContext(query) {
    try {
        // Bắt đầu thử từ một key ngẫu nhiên để phân tải
        const startIndex = getRandomStartIndex();
        
        // Gọi hàm Embedding có cơ chế Retry
        const queryVector = await callEmbeddingWithRetry(query, startIndex);

        // Gọi hàm SQL hybrid_search
        const { data, error } = await supabase.rpc('hybrid_search', {
            query_text: query,
            query_embedding: queryVector,
            match_count: 10,
            rrf_k: 60
        });

        if (error) throw error;
        return data && data.length > 0 ? data : null;

    } catch (error) {
        console.error("Lỗi tìm kiếm:", error.message);
        return null; 
    }
}

// --- 5. LOGIC RETRY CHO CHAT (GIỮ NGUYÊN) ---
async function callGeminiChat(payload, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) throw new Error("Hết Key Gemini cho Chat");

    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];
    
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        // Kiểm tra lỗi 429 từ Axios
        if (error.response && error.response.status === 429) {
            console.warn(`⚠️ Key ${currentIndex} bị 429 (Chat). Đổi sang Key kế tiếp...`);
            await sleep(1000);
            return callGeminiChat(payload, currentIndex + 1, retryCount + 1);
        }
        throw error;
    }
}

// --- 6. API ENDPOINTS ---

app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        const documents = await searchSupabaseContext(question);

        if (!documents) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan: https://mucluc.pmtl.site" });
        }

        let contextString = "";
        // Biến này vẫn giữ để phòng hờ, nhưng không dùng tạo nút to nữa
        let primaryUrl = documents[0].url; 

        documents.forEach((doc, index) => {
            contextString += `
            --- Nguồn #${index + 1} ---
            Link gốc: ${doc.url || 'N/A'}
            Nội dung: ${doc.content}
            `;
        });

        // --- 1. SỬA PROMPT ĐỂ GEMINI TRẢ VỀ LINK GỌN ---
        const systemPrompt = `
        Bạn là Phụng Sự Viên Ảo của trang "Tìm Khai Thị".
        Nhiệm vụ: Trả lời câu hỏi dựa trên context bên dưới.
        
        Yêu cầu BẮT BUỘC:
        1. Chỉ dùng thông tin trong context.
        2. QUAN TRỌNG: Sau mỗi ý trả lời, BẮT BUỘC dán ngay đường Link gốc (URL) vào ngay sau dấu chấm câu.
        3. Chỉ dán URL trần, KHÔNG viết thêm chữ như "(Xem: ...)" hay markdown. Ví dụ đúng: "...cần tịnh tâm. https://..."
        4. Giọng văn: Khiêm cung, xưng "đệ", gọi "Sư huynh/tỷ".
        
        Context:
        ${contextString}
        
        Câu hỏi: ${question}
        `;

        // Gọi Embedding Retry (như code tối ưu trước đó)
        const startIndex = getRandomStartIndex();
        const response = await callGeminiChat({
            contents: [{ parts: [{ text: systemPrompt }] }]
        }, startIndex);

        let aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, đệ chưa nghĩ ra câu trả lời.";
        
        let finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse;
        
        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

// API Admin Sync (Cũng cần dùng Embedding Retry)
app.post('/api/admin/sync-blogger', async (req, res) => {
    const { password } = req.body;
    const logs = [];

    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Sai mật khẩu Admin!" });
    }

    try {
        const { data: sourcePosts, error: sourceError } = await supabase
            .from('articles') 
            .select('*')
            .order('id', { ascending: false }) 
            .limit(20);

        if (sourceError) throw new Error("Lỗi đọc bảng articles: " + sourceError.message);
        if (!sourcePosts || sourcePosts.length === 0) return res.json({ message: "Bảng articles đang trống.", logs });

        let processedCount = 0;

        for (const post of sourcePosts) {
            const { count } = await supabase
                .from('vn_buddhism_content')
                .select('*', { count: 'exact', head: true })
                .eq('original_id', post.id);

            if (count > 0) {
                logs.push(`⚠️ Bỏ qua bài ID ${post.id}: Đã có trong Database.`);
                continue;
            }

            const rawContent = post.content || "";
            const title = post.title || "No Title";
            const url = post.url || "";
            
            if (rawContent.length < 50) continue;

            const cleanContent = cleanText(rawContent);
            const chunks = chunkText(cleanContent);
            
            logs.push(`⚙️ Đang xử lý bài: "${title.substring(0, 30)}..."`);

            for (const chunk of chunks) {
                const contextChunk = `Tiêu đề: ${title}\nNội dung: ${chunk}`;
                
                try {
                    // DÙNG HÀM EMBEDDING CÓ RETRY
                    const startIndex = getRandomStartIndex();
                    const embedding = await callEmbeddingWithRetry(contextChunk, startIndex);

                    const { error: insertError } = await supabase
                        .from('vn_buddhism_content')
                        .insert({
                            content: contextChunk,
                            embedding: embedding,
                            url: url,
                            original_id: post.id,
                            metadata: { title: title }
                        });
                    
                    if (insertError) logs.push(`❌ Lỗi lưu DB: ${insertError.message}`);

                } catch (embError) {
                    logs.push(`❌ Lỗi tạo Vector: ${embError.message}`);
                }
            }
            processedCount++;
            await sleep(500); 
        }

        res.json({ 
            message: `Hoàn tất! Đã thêm mới ${processedCount} bài viết.`, 
            logs: logs 
        });

    } catch (error) {
        console.error("Lỗi Sync:", error);
        res.status(500).json({ error: error.message, logs });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
