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

// --- 7. API SYNC BLOGGER (CHẾ ĐỘ STREAMING LOG REAL-TIME) ---
app.post('/api/admin/sync-blogger', async (req, res) => {
    const { password, blogUrl } = req.body;

    // Thiết lập Header để báo cho trình duyệt biết đây là dữ liệu dạng dòng chảy (Stream)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    if (password !== ADMIN_PASSWORD) {
        res.write("❌ Lỗi: Sai mật khẩu Admin!\n");
        return res.end();
    }
    if (!blogUrl) {
        res.write("❌ Lỗi: Thiếu địa chỉ Blog!\n");
        return res.end();
    }

    try {
        const cleanBlogUrl = blogUrl.replace(/\/$/, "");
        const rssUrl = `${cleanBlogUrl}/feeds/posts/default?alt=rss&max-results=100`;
        
        // Gửi log đầu tiên về ngay lập tức
        res.write(`📡 Đang kết nối tới RSS: ${rssUrl}\n`);

        const feed = await parser.parseURL(rssUrl);
        res.write(`✅ Tìm thấy ${feed.items.length} bài viết mới nhất.\n\n`);

        let processedCount = 0;

        for (const post of feed.items) {
            const title = post.title || "No Title";
            const url = post.link || "";
            const rawContent = post.content || post['content:encoded'] || post.contentSnippet || "";

            // Kiểm tra trùng
            const { count } = await supabase
                .from('vn_buddhism_content')
                .select('*', { count: 'exact', head: true })
                .eq('url', url);

            if (count > 0) {
                // Bài đã có -> Bỏ qua và không log để đỡ rối mắt
                continue;
            }

            if (rawContent.length < 50) continue;

            const cleanContent = cleanText(rawContent);
            const chunks = chunkText(cleanContent);
            
            // Gửi log đang xử lý bài này về Client ngay
            res.write(`⚙️ Đang nạp: "${title.substring(0, 40)}..."\n`);

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
                            metadata: { title: title, type: 'rss_auto' }
                        });
                    
                    if (insertError) {
                        res.write(`   ❌ Lỗi lưu DB: ${insertError.message}\n`);
                    }
                } catch (embError) {
                    res.write(`   ❌ Lỗi Vector: ${embError.message}\n`);
                }
            }
            processedCount++;
            // Nghỉ nhẹ để tránh spam server
            await sleep(300);
        }

        if (processedCount === 0) {
            res.write(`\n⚠️ Không có bài mới nào cần cập nhật (Tất cả đã tồn tại).\n`);
        } else {
            res.write(`\n🎉 HOÀN TẤT! Đã thêm mới thành công ${processedCount} bài viết.\n`);
        }
        
        res.end(); // Kết thúc kết nối

    } catch (error) {
        console.error("Lỗi Sync RSS:", error);
        res.write(`❌ Lỗi hệ thống: ${error.message}\n`);
        res.end();
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

// --- API MỚI: KIỂM TRA 20 BÀI MỚI NHẤT TRONG DB ---
app.post('/api/admin/check-latest', async (req, res) => {
    const { password } = req.body;

    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu Admin!" });

    try {
        // Lấy 20 dòng mới nhất, chỉ lấy các cột cần thiết để hiển thị
        const { data, error } = await supabase
            .from('vn_buddhism_content')
            .select('id, url, metadata, created_at')
            .order('id', { ascending: false })
            .limit(100);

        if (error) throw error;

        // Lọc trùng lặp URL để hiển thị danh sách bài viết duy nhất (vì 1 bài có nhiều đoạn chunk)
        // Dùng Map để giữ lại bài mới nhất của mỗi URL
        const uniquePosts = [];
        const seenUrls = new Set();

        for (const item of data) {
            if (!seenUrls.has(item.url)) {
                seenUrls.add(item.url);
                uniquePosts.push(item);
            }
        }

        res.json({ success: true, data: uniquePosts });

    } catch (error) {
        console.error("Lỗi Check DB:", error);
        res.status(500).json({ error: error.message });
    }
});
// --- API 1: LẤY TOÀN BỘ DANH SÁCH URL (VƯỢT GIỚI HẠN 1000) ---
app.post('/api/admin/get-all-urls', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });

    try {
        let allUrls = [];
        let from = 0;
        let step = 999; // Lấy tối đa 1000 dòng mỗi lần
        let keepGoing = true;

        // Vòng lặp để lấy hết dữ liệu từ Supabase
        while (keepGoing) {
            const { data, error } = await supabase
                .from('vn_buddhism_content')
                .select('url')
                .range(from, from + step);

            if (error) throw error;

            if (data.length > 0) {
                // Chỉ lấy url
                const urls = data.map(item => item.url);
                allUrls = allUrls.concat(urls);
                from += step + 1;
            } else {
                keepGoing = false; // Hết dữ liệu
            }
        }

        // Lọc trùng lặp
        const uniqueUrls = [...new Set(allUrls)];

        res.json({ 
            success: true, 
            totalRaw: allUrls.length,
            uniqueCount: uniqueUrls.length,
            urls: uniqueUrls 
        });

    } catch (error) {
        console.error("Lỗi lấy URL:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- API 2: KIỂM TRA & XÓA 1 NHÓM URL (BATCH CHECK) ---
app.post('/api/admin/check-batch', async (req, res) => {
    const { password, urls } = req.body; // Nhận vào danh sách URL cần check

    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: "Thiếu danh sách URL" });

    const results = {
        checked: 0,
        deleted: 0,
        errors: 0,
        logs: []
    };

    try {
        for (const url of urls) {
            try {
                // Ping thử link (timeout ngắn 5s)
                await axios.head(url, { timeout: 5000 });
                results.checked++;
            } catch (err) {
                // Nếu lỗi 404 -> XÓA
                if (err.response && err.response.status === 404) {
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
                    // Lỗi khác (timeout, server error...) thì bỏ qua
                    results.errors++;
                }
            }
            // Nghỉ cực ngắn 50ms để đỡ lag server
            await sleep(50);
        }
        
        res.json(results);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
