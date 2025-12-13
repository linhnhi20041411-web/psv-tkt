const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser'); // <--- THƯ VIỆN MỚI
require('dotenv').config();

const parser = new Parser();
const app = express();
const PORT = process.env.PORT || 3001;

// Tăng giới hạn body
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

// --- 2. BỘ TỪ ĐIỂN VIẾT TẮT ---
const TU_DIEN_VIET_TAT = {
    "lpdshv": "Lễ Phật Đại Sám Hối Văn",
    "ctc": "Chú Tiểu Chú",
    "dldb": "Đại Lễ Đại Bi",
    "xlp": "Xá Lợi Phất",
    "ht": "Huyền Trang",
    "ps": "Phóng sinh",
    "xf": "Xoay pháp",
    "knt": "Khai Nghiệp Tướng",
};

function dichVietTat(text) {
    if (!text) return "";
    let processedText = text;
    Object.keys(TU_DIEN_VIET_TAT).forEach(shortWord => {
        const fullWord = TU_DIEN_VIET_TAT[shortWord];
        const regex = new RegExp(`\\b${shortWord}\\b`, 'gi');
        processedText = processedText.replace(regex, fullWord);
    });
    return processedText;
}

// --- 3. CÁC HÀM TIỆN ÍCH ---
function getRandomStartIndex() {
    return Math.floor(Math.random() * apiKeys.length);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// --- 4. LOGIC RETRY EMBEDDING ---
async function callEmbeddingWithRetry(text, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) {
        throw new Error("❌ Đã thử tất cả API Keys nhưng đều bị giới hạn (429).");
    }
    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];

    try {
        const genAI = new GoogleGenerativeAI(currentKey);
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        const isQuotaError = error.message?.includes('429') || error.status === 429;
        if (isQuotaError) {
            console.warn(`⚠️ Key ${currentIndex} bị 429. Đổi key...`);
            await sleep(500);
            return callEmbeddingWithRetry(text, currentIndex + 1, retryCount + 1);
        }
        throw error;
    }
}

// --- 5. HÀM TÌM KIẾM ---
async function searchSupabaseContext(query) {
    try {
        const startIndex = getRandomStartIndex();
        const queryVector = await callEmbeddingWithRetry(query, startIndex);

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

// --- 6. API CHAT ---
async function callGeminiChat(payload, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) throw new Error("Hết Key Gemini cho Chat");
    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.warn(`⚠️ Key ${currentIndex} bị 429 (Chat). Đổi key...`);
            await sleep(1000);
            return callGeminiChat(payload, currentIndex + 1, retryCount + 1);
        }
        throw error;
    }
}

app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        const fullQuestion = dichVietTat(question);
        console.log(`🔍 Chat: "${question}" -> Dịch: "${fullQuestion}"`);

        const documents = await searchSupabaseContext(fullQuestion);

        if (!documents) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan: https://mucluc.pmtl.site" });
        }

        let contextString = "";
        documents.forEach((doc, index) => {
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
        2. QUAN TRỌNG: Sau mỗi ý trả lời, BẮT BUỘC dán ngay đường Link gốc (URL) vào ngay sau dấu chấm câu.
        3. Chỉ dán URL trần, KHÔNG viết thêm chữ như "(Xem: ...)" hay markdown. Ví dụ đúng: "...cần tịnh tâm. https://..."
        4. Giọng văn: Khiêm cung, xưng "đệ", gọi "Sư huynh".
        Context:
        ${contextString}
        Câu hỏi gốc: ${question}
        Ý nghĩa đầy đủ: ${fullQuestion}
        `;

        const startIndex = getRandomStartIndex();
        const response = await callGeminiChat({
            contents: [{ parts: [{ text: systemPrompt }] }]
        }, startIndex);

        let aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, đệ chưa nghĩ ra câu trả lời.";
        res.json({ answer: "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

// --- 7. API SYNC BLOGGER TRỰC TIẾP TỪ RSS (ĐÃ CẬP NHẬT) ---
app.post('/api/admin/sync-blogger', async (req, res) => {
    const { password, blogUrl } = req.body; // Nhận thêm blogUrl
    const logs = [];

    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu Admin!" });
    if (!blogUrl) return res.status(400).json({ error: "Vui lòng nhập địa chỉ Blog!" });

    try {
        // Tạo đường dẫn RSS: Lấy 50 bài mới nhất
        // Nếu blogUrl có dấu / ở cuối thì bỏ đi
        const cleanBlogUrl = blogUrl.replace(/\/$/, "");
        const rssUrl = `${cleanBlogUrl}/feeds/posts/default?alt=rss&max-results=100`;
        
        logs.push(`📡 Đang kết nối tới RSS: ${rssUrl}`);

        const feed = await parser.parseURL(rssUrl);
        logs.push(`✅ Tìm thấy ${feed.items.length} bài viết mới nhất trên Blog.`);

        let processedCount = 0;

        for (const post of feed.items) {
            const title = post.title || "No Title";
            const url = post.link || "";
            const rawContent = post.content || post['content:encoded'] || post.contentSnippet || "";

            // 1. Kiểm tra bài này đã có trong Database chưa (Dựa vào URL)
            const { count } = await supabase
                .from('vn_buddhism_content')
                .select('*', { count: 'exact', head: true })
                .eq('url', url);

            if (count > 0) {
                logs.push(`⚠️ Bỏ qua: "${title.substring(0, 20)}..." (Đã có).`);
                continue;
            }

            if (rawContent.length < 50) continue;

            // 2. Xử lý bài mới
            const cleanContent = cleanText(rawContent);
            const chunks = chunkText(cleanContent);
            logs.push(`⚙️ Đang xử lý: "${title.substring(0, 30)}..." (${chunks.length} đoạn)`);

            for (const chunk of chunks) {
                const contextChunk = `Tiêu đề: ${title}\nNội dung: ${chunk}`;
                try {
                    const startIndex = getRandomStartIndex();
                    const embedding = await callEmbeddingWithRetry(contextChunk, startIndex);
                    
                    const { error: insertError } = await supabase
                        .from('vn_buddhism_content')
                        .insert({
                            content: contextChunk,
                            embedding: embedding,
                            url: url,
                            original_id: 0, // 0 vì lấy từ RSS, không có ID số
                            metadata: { title: title, type: 'rss_auto' }
                        });
                    
                    if (insertError) logs.push(`❌ Lỗi lưu DB: ${insertError.message}`);
                } catch (embError) {
                    logs.push(`❌ Lỗi Vector: ${embError.message}`);
                }
            }
            processedCount++;
            await sleep(500); // Nghỉ nhẹ
        }

        res.json({ message: `Hoàn tất! Đã thêm mới ${processedCount} bài.`, logs: logs });

    } catch (error) {
        console.error("Lỗi Sync RSS:", error);
        res.json({ message: "Lỗi Sync", error: error.message, logs });
    }
});

// API MANUAL ADD
app.post('/api/admin/manual-add', async (req, res) => {
    const { password, url, title, content } = req.body;
    const logs = [];

    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu Admin!" });
    if (!url || !content) return res.status(400).json({ error: "Thiếu URL hoặc Nội dung" });

    try {
        logs.push(`🚀 Xử lý thủ công: "${title}"`);

        const { error: deleteError } = await supabase
            .from('vn_buddhism_content')
            .delete().eq('url', url);
        if (!deleteError) logs.push(`🧹 Đã dọn dẹp dữ liệu cũ.`);

        const cleanContent = cleanText(content);
        const chunks = chunkText(cleanContent);
        
        let successCount = 0;
        for (const chunk of chunks) {
            const contextChunk = `Tiêu đề: ${title}\nNội dung: ${chunk}`;
            try {
                const startIndex = getRandomStartIndex();
                const embedding = await callEmbeddingWithRetry(contextChunk, startIndex);
                const { error: insertError } = await supabase
                    .from('vn_buddhism_content')
                    .insert({
                        content: contextChunk,
                        embedding: embedding,
                        url: url,
                        original_id: 0, 
                        metadata: { title: title, type: 'manual' }
                    });
                if (!insertError) successCount++;
            } catch (e) { logs.push(`❌ Lỗi: ${e.message}`); }
            await sleep(300);
        }
        res.json({ message: `Thành công! Lưu ${successCount}/${chunks.length} đoạn.`, logs: logs });
    } catch (error) {
        res.status(500).json({ error: error.message, logs });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
