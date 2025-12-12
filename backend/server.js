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
// Mật khẩu mặc định nếu quên đặt trên Render
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456"; 

if (!supabaseUrl || !supabaseKey) console.error("❌ LỖI: Thiếu SUPABASE_URL hoặc SUPABASE_KEY");

const supabase = createClient(supabaseUrl, supabaseKey);

function getRandomKey() {
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
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

// --- 3. API CHAT (HYBRID SEARCH) ---
async function searchSupabaseContext(query) {
    try {
        const genAI = new GoogleGenerativeAI(getRandomKey());
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        
        const result = await model.embedContent(query);
        const queryVector = result.embedding.values;

        // Gọi hàm SQL hybrid_search
        const { data, error } = await supabase.rpc('hybrid_search', {
            query_text: query,
            query_embedding: queryVector,
            match_count: 10,
            rrf_k: 60 // Tham số mặc định của RRF
        });

        if (error) throw error;
        return data && data.length > 0 ? data : null;

    } catch (error) {
        console.error("Lỗi tìm kiếm:", error);
        return null; 
    }
}

async function callGeminiChat(payload, keyIndex = 0) {
    if (keyIndex >= apiKeys.length) throw new Error("Hết Key Gemini");
    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        if (error.response && error.response.status === 429) {
            await sleep(1000);
            return callGeminiChat(payload, keyIndex + 1);
        }
        throw error;
    }
}

app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        const documents = await searchSupabaseContext(question);

        if (!documents) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan: https://mucluc.pmtl.site" });
        }

        let contextString = "";
        let primaryUrl = documents[0].url;

        documents.forEach((doc, index) => {
            // Quan trọng: Đưa link vào ngay context để AI trích dẫn
            contextString += `
            --- Nguồn #${index + 1} ---
            Link gốc: ${doc.url || 'N/A'}
            Nội dung: ${doc.content}
            `;
        });

        const systemPrompt = `
        Bạn là Phụng Sự Viên Ảo của trang "Tìm Khai Thị".
        Nhiệm vụ: Trả lời câu hỏi dựa trên context bên dưới.
        
        Yêu cầu BẮT BUỘC:
        1. Chỉ dùng thông tin trong context.
        2. Sau mỗi ý trả lời, BẮT BUỘC ghi chú link nguồn bên cạnh. Ví dụ: "...cần tịnh tâm (Xem: URL)".
        3. Giọng văn: Khiêm cung, xưng "đệ", gọi "Sư huynh/tỷ".
        4. Nếu không tìm thấy câu trả lời trong context, hãy nói khéo là chưa tìm thấy và mời xem mục lục.
        
        Context:
        ${contextString}
        
        Câu hỏi: ${question}
        `;

        const response = await callGeminiChat({
            contents: [{ parts: [{ text: systemPrompt }] }]
        });

        let aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, đệ chưa nghĩ ra câu trả lời.";
        
        let finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse;
        
        // Thêm nút xem thêm đẹp mắt
        if (primaryUrl && primaryUrl.startsWith('http')) {
             finalAnswer += `\n\n<br><a href="${primaryUrl}" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:8px 16px; border-radius:20px; text-decoration:none; font-weight:bold; font-size: 14px; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">👉 Xem Bài Gốc Khớp Nhất</a>`;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi Chat:", error);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

// --- 4. API ADMIN SYNC (Đã tối ưu) ---
app.post('/api/admin/sync-blogger', async (req, res) => {
    const { password } = req.body;
    const logs = [];

    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Sai mật khẩu Admin!" });
    }

    try {
        // Lấy 20 bài mới nhất từ bảng 'articles' (bảng trung gian chứa dữ liệu Blogger)
        const { data: sourcePosts, error: sourceError } = await supabase
            .from('articles') 
            .select('*')
            .order('id', { ascending: false }) 
            .limit(20);

        if (sourceError) throw new Error("Lỗi đọc bảng articles: " + sourceError.message);
        if (!sourcePosts || sourcePosts.length === 0) return res.json({ message: "Bảng articles đang trống.", logs });

        const genAI = new GoogleGenerativeAI(getRandomKey());
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});

        let processedCount = 0;

        for (const post of sourcePosts) {
            // Kiểm tra trùng lặp dựa trên ID bài viết gốc
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
            
            logs.push(`⚙️ Đang xử lý bài: "${title.substring(0, 30)}..." (${chunks.length} chunks)`);

            for (const chunk of chunks) {
                const contextChunk = `Tiêu đề: ${title}\nNội dung: ${chunk}`;
                
                // Tạo Vector
                const result = await model.embedContent(contextChunk);
                const embedding = result.embedding.values;

                // Lưu vào Supabase (ĐÃ BẬT METADATA)
                const { error: insertError } = await supabase
                    .from('vn_buddhism_content')
                    .insert({
                        content: contextChunk,
                        embedding: embedding,
                        url: url,
                        original_id: post.id,
                        metadata: { title: title } // Quan trọng: Lưu tiêu đề để sau này dễ quản lý
                    });
                
                if (insertError) {
                    logs.push(`❌ Lỗi lưu chunk: ${insertError.message}`);
                }
            }
            processedCount++;
            await sleep(500); 
        }

        res.json({ 
            message: `Hoàn tất! Đã thêm mới ${processedCount} bài viết vào bộ nhớ AI.`, 
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
