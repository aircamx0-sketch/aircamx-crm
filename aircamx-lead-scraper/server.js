import express from "express";
import fs from "fs";
import csv from "csv-parser";
import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let leads = [];

function scoreLead(lead) {
  const photoCount = Number(lead.photo_count || 0);
  const price = Number(String(lead.price || "").replace(/[^0-9]/g, ""));

  let score = 0;

  if (photoCount === 0) score += 70;
  else if (photoCount <= 3) score += 55;
  else if (photoCount <= 8) score += 30;
  else score += 10;

  if (price >= 600000) score += 20;
  if (photoCount <= 3) score += 10;

  return Math.min(score, 100);
}

function generateMessage(lead) {
  return `Hey ${lead.agent_name || "there"}, I saw your listing at ${lead.address || "your listing"}${lead.city ? " in " + lead.city : ""}. AirCamX can help with photos, drone, video, and fast turnaround. Want pricing + examples?`;
}

async function generateAIMessage(lead) {
  const prompt = `
Write a short high-converting SMS for AirCamX.

AirCamX offers real estate media:
- HDR listing photos
- drone photos
- video walkthroughs
- 3D tours
- fast 24-hour turnaround

Rules:
- Keep under 280 characters
- Sound casual and human
- Do not sound spammy
- Mention weak/no photos only if photo count is 3 or less
- End by asking if they want pricing and examples

Lead:
Address: ${lead.address || "Unknown"}
City: ${lead.city || "Arizona"}
Price: ${lead.price || "Unknown"}
Photo count: ${lead.photo_count || "Unknown"}
Agent name: ${lead.agent_name || "Agent"}
`;

  const result = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return result.choices[0].message.content.trim();
}

function loadLeads() {
  return new Promise((resolve, reject) => {
    const results = [];

    if (!fs.existsSync("leads.csv")) {
      return reject(new Error("leads.csv not found"));
    }

    fs.createReadStream("leads.csv")
      .pipe(csv())
      .on("data", async (data) => {
        results.push({
          id: crypto.randomUUID(),
          ...data,
          score: scoreLead(data),
          sms: generateMessage(data),
          status: "new",
          notes: "",
          last_touch: "",
          deal_value: "",
          next_follow_up: ""
        });
      })
      .on("end", () => resolve(results))
      .on("error", reject);
  });
}

async function parseListingUrl(url) {
  const response = await axios.get(url, {
    timeout: 12000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    }
  });

  const html = response.data;
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text() ||
    "";

  const description =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content") ||
    "";

  const combined = `${title} ${description}`;

  const priceMatch = combined.match(/\$[\d,]+/);
  const price = priceMatch ? priceMatch[0].replace(/[^0-9]/g, "") : "";

  let address = title.split("|")[0]?.trim() || "";

  if (!address || address.length > 140) {
    address = title.substring(0, 100).trim() || "Review URL manually";
  }

  const imgCount = $("img").length || 0;

  return {
    listing_url: url,
    address,
    city: "",
    price,
    agent_name: "",
    agent_phone: "",
    agent_email: "",
    photo_count: imgCount,
    import_status: "needs_review"
  };
}

app.get("/api/load", async (req, res) => {
  try {
    leads = await loadLeads();

    for (const lead of leads) {
      lead.sms = await generateAIMessage(lead);
    }

    res.json({
      success: true,
      total: leads.length,
      leads
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/leads", (req, res) => {
  res.json({
    total: leads.length,
    leads
  });
});

app.post("/api/add-lead", async (req, res) => {
  try {
    const data = req.body;

    const newLead = {
      id: crypto.randomUUID(),
      ...data,
      score: scoreLead(data),
      sms: await generateAIMessage(data),
      status: "new",
      notes: "",
      last_touch: "",
      deal_value: "",
      next_follow_up: ""
    };

    leads.unshift(newLead);

    res.json({
      success: true,
      lead: newLead
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/import-urls", async (req, res) => {
  try {
    const { urls } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No URLs provided"
      });
    }

    const imported = [];

    for (const url of urls) {
      try {
        const parsed = await parseListingUrl(url);

        const newLead = {
          id: crypto.randomUUID(),
          ...parsed,
          score: scoreLead(parsed),
          sms: await generateAIMessage(parsed),
          status: "new",
          notes: "Imported from URL. Review missing fields like agent phone, city, and photo count.",
          last_touch: "",
          deal_value: "",
          next_follow_up: ""
        };

        leads.unshift(newLead);
        imported.push(newLead);
      } catch (error) {
        const failedLead = {
          id: crypto.randomUUID(),
          listing_url: url,
          address: "Failed to read URL",
          city: "",
          price: "",
          agent_name: "",
          agent_phone: "",
          agent_email: "",
          photo_count: "",
          score: 0,
          sms: "Review this listing manually, then generate/send message.",
          status: "needs_review",
          notes: "URL import failed. Site may block automated reading.",
          last_touch: "",
          deal_value: "",
          next_follow_up: ""
        };

        leads.unshift(failedLead);
        imported.push(failedLead);
      }
    }

    res.json({
      success: true,
      total: imported.length,
      leads: imported
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.patch("/api/leads/:id", (req, res) => {
  const { id } = req.params;
  const index = leads.findIndex((lead) => lead.id === id);

  if (index === -1) {
    return res.status(404).json({
      success: false,
      error: "Lead not found"
    });
  }

  leads[index] = {
    ...leads[index],
    ...req.body
  };

  res.json({
    success: true,
    lead: leads[index]
  });
});

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => {
  console.log(`AirCamX CRM running on http://localhost:${PORT}`);
});