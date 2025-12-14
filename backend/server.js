const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser'); 
require('dotenv').config();

const parser = new Parser();
const app = express();
const PORT = process.env.PORT || 3001;

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

// --- 2. CÁC HÀM TIỆN ÍCH ---
function getRandomStartIndex() { return Math.floor(Math.random() * apiKeys.length); }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function cleanText(text) {
    if (!text) return "";
    let clean = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').replace(/\r\n/g, '\n');   
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
        if ((currentChunk.length + cleanP.length) < maxChunkSize) { currentChunk += (currentChunk ? "\n\n" : "") + cleanP; }
        else { if (currentChunk.length > 50) chunks.push(currentChunk); currentChunk = cleanP; }
    }
    if (currentChunk.length > 50) chunks.push(currentChunk);
    return chunks;
}

// --- 3. GỌI GEMINI (Dùng chung cho cả Chat và Phân tích) ---
async function callGeminiAPI(payload, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) throw new Error("Hết Key Gemini.");
    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];
    const model = "gemini-2.5-flash"; // Model nhanh và rẻ để phân tích keyword
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.warn(`⚠️ Key ${currentIndex} bị 429. Đổi key...`);
            await sleep(1000);
            return callGeminiAPI(payload, currentIndex + 1, retryCount + 1);
        }
        throw error;
    }
}

// --- 4. HÀM AI TRÍCH XUẤT TỪ KHÓA (QUAN TRỌNG NHẤT) ---
// Đây là bộ não phân tích câu hỏi trước khi tìm kiếm
async function aiExtractKeywords(userQuestion) {
    const prompt = `
    Nhiệm vụ: Bạn là một chuyên gia tìm kiếm dữ liệu (SEO Expert).
    Hãy phân tích câu hỏi của người dùng và trích xuất ra "Cụm từ khóa trọng tâm" (Search Query) để tìm trong cơ sở dữ liệu.
    
    Yêu cầu:
    1. Loại bỏ hoàn toàn các từ ngữ giao tiếp, đại từ nhân xưng, từ đệm (ví dụ: "mình muốn", "cho hỏi", "có khai thị nào", "liên quan không", "về việc", "như thế nào"...).
    2. Chỉ giữ lại DANH TỪ và ĐỘNG TỪ chính mô tả vấn đề cụ thể.
    3. Kết quả trả về CHỈ LÀ TỪ KHÓA, không thêm dấu ngoặc kép hay giải thích.

    Ví dụ 1:
    Input: "mình muốn mở nhà hàng chay, có khai thị nào liên quan không ?"
    Output: mở nhà hàng chay

    Ví dụ 2:
    Input: "làm sao để niệm kinh cho người bệnh ung thư"
    Output: niệm kinh ung thư

    Ví dụ 3:
    Input: "ý nghĩa của việc phóng sinh là gì vậy bạn"
    Output: ý nghĩa phóng sinh

    Input hiện tại: "${userQuestion}"
    Output:
    `;

    try {
        const startIndex = getRandomStartIndex();
        const response = await callGeminiAPI({
            contents: [{ parts: [{ text: prompt }] }]
        }, startIndex);
        
        const keywords = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || userQuestion;
        // Xử lý sạch sẽ (bỏ xuống dòng nếu có)
        return keywords.replace(/\n/g, " ").trim();
    } catch (e) {
        console.error("Lỗi AI Extract:", e.message);
        return userQuestion; // Nếu lỗi thì dùng tạm câu gốc
    }
}

// --- 5. HÀM EMBEDDING (Vector) ---
async function callEmbeddingWithRetry(text, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) throw new Error("Hết Key Embedding.");
    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];

    try {
        const genAI = new GoogleGenerativeAI(currentKey);
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        if (error.message?.includes('429') || error.status === 429) {
            await sleep(500);
            return callEmbeddingWithRetry(text, currentIndex + 1, retryCount + 1);
        }
        throw error;
    }
}

// --- 6. HÀM TÌM KIẾM SUPABASE ---
async function searchSupabaseContext(query) {
    try {
        const startIndex = getRandomStartIndex();
        const queryVector = await callEmbeddingWithRetry(query, startIndex);

        const { data, error } = await supabase.rpc('hybrid_search', {
            query_text: query,
            query_embedding: queryVector,
            match_count: 20, // Lấy 20 bài tốt nhất
            rrf_k: 60
        });

        if (error) throw error;
        return data && data.length > 0 ? data : null;
    } catch (error) {
        console.error("Lỗi tìm kiếm:", error.message);
        return null; 
    }
}

// --- 7. API CHAT (LOGIC MỚI: AI-DRIVEN) ---
app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        // BƯỚC 1: DÙNG AI ĐỂ HIỂU Ý ĐỊNH VÀ TRÍCH XUẤT TỪ KHÓA
        // Thay vì dùng code cứng nhắc, ta nhờ Gemini "dịch" câu hỏi người dùng thành ngôn ngữ tìm kiếm.
        const searchKeywords = await aiExtractKeywords(question);
        
        console.log(`🗣️ User hỏi: "${question}"`);
        console.log(`🧠 AI Phân tích ra từ khóa: "${searchKeywords}"`);

        // BƯỚC 2: TÌM KIẾM BẰNG TỪ KHÓA CỦA AI
        // Lúc này searchKeywords sẽ là "mở nhà hàng chay" -> Khớp 100% với bài viết trong DB
        const documents = await searchSupabaseContext(searchKeywords);

        if (!documents) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại mục lục tổng quan: https://mucluc.pmtl.site" });
        }

        let contextString = "";
        documents.forEach((doc, index) => {
            contextString += `
            --- Nguồn #${index + 1} ---
            Link: ${doc.url}
            Tiêu đề: ${doc.metadata?.title || 'Không có tiêu đề'}
            Nội dung: ${doc.content.substring(0, 800)}... 
            `;
        });

        // BƯỚC 3: TRẢ LỜI
        const systemPrompt = `
        Bạn là Phụng Sự Viên Ảo.
        Câu hỏi gốc: "${question}"
        Từ khóa trọng tâm: "${searchKeywords}" (Đây là chủ đề chính, hãy bám sát nó).

        Dữ liệu tham khảo (Context):
        ${contextString}

        Yêu cầu:
        1. Tìm trong Context bài viết nào khớp nhất với "Từ khóa trọng tâm" (Ví dụ: nếu từ khóa là "mở nhà hàng", hãy ưu tiên bài nói về việc mở nhà hàng, bỏ qua các bài chỉ nói về ăn chay chung chung).
        2. Trả lời câu hỏi dựa trên bài viết khớp nhất đó.
        3. Cuối câu trả lời, BẮT BUỘC dán Link gốc (URL) của bài viết tham khảo.

        Trả lời:
        `;

        const startIndex = getRandomStartIndex();
        const response = await callGeminiAPI({
            contents: [{ parts: [{ text: systemPrompt }] }]
        }, startIndex);

        let aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, đệ chưa nghĩ ra câu trả lời.";
        res.json({ answer: "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

// ... (Các API Admin/Sync giữ nguyên như cũ, không cần sửa) ...
// API Sync Blogger, Manual Add, Check Latest, Get All Urls, Check Batch 
// Bạn copy lại các đoạn API Admin từ câu trả lời trước vào đây nhé.
// Để cho gọn mình không paste lại toàn bộ phần Admin ở đây.

// --- API SYNC BLOGGER ---
app.post('/api/admin/sync-blogger', async (req, res) => {
    const { password, blogUrl } = req.body;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Transfer-Encoding', 'chunked');
    if (password !== ADMIN_PASSWORD) { res.write("❌ Sai mật khẩu!\n"); return res.end(); }
    
    try {
        const cleanBlogUrl = blogUrl.replace(/\/$/, "");
        const rssUrl = `${cleanBlogUrl}/feeds/posts/default?alt=rss&max-results=100`;
        res.write(`📡 Đang kết nối RSS: ${rssUrl}\n`);
        const feed = await parser.parseURL(rssUrl);
        res.write(`✅ Tìm thấy ${feed.items.length} bài.\n`);
        
        for (const post of feed.items) {
            const { count } = await supabase.from('vn_buddhism_content').select('*', { count: 'exact', head: true }).eq('url', post.link);
            if (count > 0) continue;
            
            const cleanContent = cleanText(post.content || post['content:encoded'] || "");
            if (cleanContent.length < 50) continue;
            
            const chunks = chunkText(cleanContent);
            res.write(`⚙️ Nạp: ${post.title.substring(0,30)}...\n`);
            
            for (const chunk of chunks) {
                try {
                    const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${post.title}\nNội dung: ${chunk}`, getRandomStartIndex());
                    await supabase.from('vn_buddhism_content').insert({
                        content: `Tiêu đề: ${post.title}\nNội dung: ${chunk}`, embedding, url: post.link, original_id: 0, metadata: { title: post.title, type: 'rss_auto' }
                    });
                } catch (e) { res.write(`❌ Lỗi: ${e.message}\n`); }
            }
            await sleep(300);
        }
        res.write(`\n🎉 HOÀN TẤT!\n`); res.end();
    } catch (e) { res.write(`❌ Lỗi: ${e.message}\n`); res.end(); }
});

// API MANUAL ADD
app.post('/api/admin/manual-add', async (req, res) => {
    const { password, url, title, content } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        await supabase.from('vn_buddhism_content').delete().eq('url', url);
        const chunks = chunkText(cleanText(content));
        for (const chunk of chunks) {
            const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${title}\nNội dung: ${chunk}`, getRandomStartIndex());
            await supabase.from('vn_buddhism_content').insert({
                content: `Tiêu đề: ${title}\nNội dung: ${chunk}`, embedding, url, original_id: 0, metadata: { title, type: 'manual' }
            });
            await sleep(300);
        }
        res.json({ message: "Thành công!", logs: ["Đã lưu xong."] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
