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

// --- 2. BỘ TỪ ĐIỂN VIẾT TẮT (ĐÃ CẬP NHẬT ĐẦY ĐỦ THEO YÊU CẦU) ---
// Hệ thống sẽ tự động thay thế các từ này trước khi xử lý
const TU_DIEN_VIET_TAT = {
    "pmtl": "Pháp Môn Tâm Linh",
    "btpp": "Bạch Thoại Phật Pháp",
    "nnn": "Ngôi nhà nhỏ",
    "psv": "Phụng Sự Viên",
    "sh": "Sư Huynh",
    "kbt": "Kinh Bài Tập",
    "ps": "Phóng Sinh",
    "cđb": "Chú Đại Bi",
    "cdb": "Chú Đại Bi", 
    "tk": "Tâm Kinh",
    "lpdshv": "Lễ Phật Đại Sám Hối Văn",
    "vsc": "Vãng Sanh Chú",
    "cdbstc": "Công Đức Bảo Sơn Thần Chú",
    "cđbstc": "Công Đức Bảo Sơn Thần Chú",
    "nyblvdln": "Như Ý Bảo Luân Vương Đà La Ni",
    "bkcn": "Bổ Khuyết Chân Ngôn",
    "tpdtcn": "Thất Phật Diệt Tội Chân Ngôn",
    "qalccn": "Quán Âm Linh Cảm Chân Ngôn",
    "tvltqdqmvtdln": "Thánh Vô Lượng Thọ Quyết Định Quang Minh Vương Đà La Ni",
};

// Hàm dịch từ viết tắt (Không phân biệt hoa thường)
function dichVietTat(text) {
    if (!text) return "";
    let processedText = text;
    
    // Sắp xếp từ khóa dài thay thế trước để tránh lỗi chồng chéo
    const keys = Object.keys(TU_DIEN_VIET_TAT).sort((a, b) => b.length - a.length);

    keys.forEach(shortWord => {
        const fullWord = TU_DIEN_VIET_TAT[shortWord];
        // Regex: \b là ranh giới từ (để tránh thay thế nhầm chữ nằm trong từ khác)
        // 'gi': g = global (thay tất cả), i = case-insensitive (không phân biệt hoa thường)
        const regex = new RegExp(`\\b${shortWord}\\b`, 'gi');
        processedText = processedText.replace(regex, fullWord);
    });
    
    return processedText;
}

// --- 3. CÁC HÀM TIỆN ÍCH ---
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

// --- 4. GỌI GEMINI ---
async function callGeminiAPI(payload, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) throw new Error("Hết Key Gemini.");
    const currentIndex = keyIndex % apiKeys.length;
    const currentKey = apiKeys[currentIndex];
    const model = "gemini-2.5-flash"; 
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

// --- 5. AI EXTRACT KEYWORDS (ĐÃ CẬP NHẬT INPUT ĐÃ DỊCH) ---
async function aiExtractKeywords(userQuestion) {
    const prompt = `
    Nhiệm vụ: Bạn là chuyên gia tìm kiếm (SEO). 
    Hãy trích xuất "Cụm từ khóa trọng tâm" (Search Query) từ câu hỏi.
    
    Yêu cầu:
    1. Loại bỏ từ giao tiếp (mình, muốn, cho hỏi, là gì, thế nào...).
    2. Giữ lại DANH TỪ và ĐỘNG TỪ chính mô tả vấn đề.
    3. Trả về CHỈ TỪ KHÓA.

    Ví dụ: "ý nghĩa của việc phóng sinh là gì" -> phóng sinh ý nghĩa
    Input: "${userQuestion}"
    Output:
    `;

    try {
        const startIndex = getRandomStartIndex();
        const response = await callGeminiAPI({
            contents: [{ parts: [{ text: prompt }] }]
        }, startIndex);
        
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().replace(/\n/g, " ") || userQuestion;
    } catch (e) {
        console.error("Lỗi AI Extract:", e.message);
        return userQuestion;
    }
}

// --- 6. HÀM EMBEDDING & SEARCH ---
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

async function searchSupabaseContext(query) {
    try {
        const startIndex = getRandomStartIndex();
        const queryVector = await callEmbeddingWithRetry(query, startIndex);

        const { data, error } = await supabase.rpc('hybrid_search', {
            query_text: query,
            query_embedding: queryVector,
            match_count: 20, 
            rrf_k: 60
        });

        if (error) throw error;
        return data && data.length > 0 ? data : null;
    } catch (error) {
        console.error("Lỗi tìm kiếm:", error.message);
        return null; 
    }
}

// --- 7. API CHAT (CÓ DỊCH VIẾT TẮT) ---
app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        // BƯỚC 1: DỊCH VIẾT TẮT (QUAN TRỌNG)
        // "lpdshv có tác dụng gì" -> "Lễ Phật Đại Sám Hối Văn có tác dụng gì"
        const fullQuestion = dichVietTat(question);
        
        // BƯỚC 2: AI TRÍCH XUẤT TỪ KHÓA TỪ CÂU ĐÃ DỊCH
        const searchKeywords = await aiExtractKeywords(fullQuestion);
        
        console.log(`🗣️ User (Gốc): "${question}"`);
        console.log(`📝 Đã dịch: "${fullQuestion}"`);
        console.log(`🧠 Từ khóa AI: "${searchKeywords}"`);

        // BƯỚC 3: TÌM KIẾM
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

        // BƯỚC 4: TRẢ LỜI
        const systemPrompt = `
        Bạn là Phụng Sự Viên Ảo.
        Câu hỏi gốc (đã dịch nghĩa): "${fullQuestion}"
        Từ khóa trọng tâm: "${searchKeywords}"

        Dữ liệu tham khảo (Context):
        ${contextString}

        Yêu cầu:
        1. Tìm bài viết khớp nhất với "Từ khóa trọng tâm".
        2. Trả lời câu hỏi dựa trên bài viết đó.
        3. Cuối câu trả lời, BẮT BUỘC dán Link gốc (URL).

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

// --- CÁC API ADMIN (GIỮ NGUYÊN) ---
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

app.post('/api/admin/get-all-urls', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        let allUrls = [], from = 0, step = 999, keepGoing = true;
        while (keepGoing) {
            const { data, error } = await supabase.from('vn_buddhism_content').select('url').range(from, from + step);
            if (error) throw error;
            if (data.length > 0) { allUrls = allUrls.concat(data.map(i => i.url)); from += step + 1; } else { keepGoing = false; }
        }
        res.json({ success: true, urls: [...new Set(allUrls)] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API 2: KIỂM TRA & XÓA (NÂNG CẤP: PHÁT HIỆN SOFT 404 BLOGGER) ---
app.post('/api/admin/check-batch', async (req, res) => {
    const { password, urls } = req.body;

    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: "Thiếu danh sách URL" });

    const results = {
        checked: 0,
        deleted: 0,
        errors: 0,
        logs: []
    };

    // Chuỗi văn bản đặc trưng khi Blogger báo lỗi (Soft 404)
    const BLOGGER_ERROR_TEXT = "Rất tiếc, trang bạn đang tìm trong blog này không tồn tại";
    const BLOGGER_ERROR_TEXT_EN = "Sorry, the page you were looking for in this blog does not exist";

    try {
        for (const url of urls) {
            try {
                // 1. Dùng GET thay vì HEAD để đọc được nội dung HTML
                // Timeout tăng lên 8s vì tải HTML lâu hơn tải Header
                const response = await axios.get(url, { 
                    timeout: 8000,
                    validateStatus: function (status) {
                        return status < 500; // Coi 404 là hợp lệ để xử lý bên dưới
                    }
                });
                
                let isDeadLink = false;

                // 2. Kiểm tra mã lỗi chuẩn (Hard 404)
                if (response.status === 404) {
                    isDeadLink = true;
                } 
                // 3. Kiểm tra lỗi "giả vờ" (Soft 404) - Status 200 nhưng nội dung báo lỗi
                else if (response.status === 200) {
                    const htmlContent = response.data;
                    if (typeof htmlContent === 'string') {
                        // Kiểm tra xem trong HTML có chứa câu báo lỗi của Blogger không
                        if (htmlContent.includes(BLOGGER_ERROR_TEXT) || htmlContent.includes(BLOGGER_ERROR_TEXT_EN)) {
                            isDeadLink = true;
                            results.logs.push(`⚠️ Phát hiện Soft 404 (Blogger): ${url}`);
                        }
                    }
                }

                // 4. Nếu xác định là Link chết -> XÓA
                if (isDeadLink) {
                    const { error: delError } = await supabase
                        .from('vn_buddhism_content')
                        .delete()
                        .eq('url', url);

                    if (!delError) {
                        results.deleted++;
                        results.logs.push(`🗑️ Đã xóa link chết: ${url}`);
                    } else {
                        results.errors++;
                        results.logs.push(`⚠️ Lỗi xóa DB: ${url}`);
                    }
                } else {
                    results.checked++; // Link sống
                }

            } catch (err) {
                // Các lỗi kết nối mạng (DNS, Timeout...) thì tạm bỏ qua, không xóa vội tránh xóa nhầm
                results.errors++;
                // console.log(`Lỗi kết nối ${url}: ${err.message}`);
            }
            
            // Nghỉ 100ms giữa các lần check
            await sleep(100);
        }
        
        res.json(results);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/check-latest', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        const { data } = await supabase.from('vn_buddhism_content').select('id, url, metadata, created_at').order('id', { ascending: false }).limit(20);
        const unique = []; const seen = new Set();
        data.forEach(i => { if (!seen.has(i.url)) { seen.add(i.url); unique.push(i); } });
        res.json({ success: true, data: unique });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
