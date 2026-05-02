import express from "express";
import fs from "fs";
import csv from "csv-parser";
import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import OpenAI from "openai";
import { google } from "googleapis";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Leads";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

const headers = [
  "id","address","city","price","agent_name","agent_phone","agent_email",
  "photo_count","listing_url","status","sms","email","follow_up_sms",
  "follow_up_email","last_message_date","next_follow_up","notes",
  "deal_value","created_at"
];

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function rowToLead(row) {
  const lead = {};
  headers.forEach((h, i) => lead[h] = row[i] || "");
  lead.score = scoreLead(lead);
  return lead;
}

function leadToRow(lead) {
  return headers.map(h => lead[h] || "");
}

function scoreLead(lead) {
  const photoCount = Number(lead.photo_count || 0);
  const price = Number(String(lead.price || "").replace(/[^0-9]/g, ""));

  let score = 0;
  if (photoCount === 0) score += 80;
  else if (photoCount <= 3) score += 65;
  else if (photoCount <= 8) score += 35;
  else score += 10;

  if (price >= 600000) score += 20;
  return Math.min(score, 100);
}

async function aiText(prompt) {
  const result = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return result.choices[0].message.content.trim();
}

async function generateInitialSMS(lead) {
  return aiText(`
Write a very human SMS for AirCamX.

Rules:
- Under 280 characters
- Casual, personal, not salesy
- Mention the specific property
- If photo count is 0-3, softly mention the listing looks like it may still need media
- Offer photos, drone, video, 3D tour, 24-hour turnaround
- End with: "Want me to send pricing + examples?"

Lead:
Address: ${lead.address}
City: ${lead.city}
Price: ${lead.price}
Agent: ${lead.agent_name || "Agent"}
Photo count: ${lead.photo_count || "unknown"}
`);
}

async function generateInitialEmail(lead) {
  return aiText(`
Write a short friendly email for AirCamX real estate media.

Rules:
- Subject line first like: Subject: ...
- Short, human, not corporate
- Mention the property address
- Offer photos, drone, video, 3D tour, fast turnaround
- Ask if they want pricing and examples

Lead:
${JSON.stringify(lead, null, 2)}
`);
}

async function generateFollowUpSMS(lead) {
  return aiText(`
Write a natural follow-up SMS for AirCamX.

Rules:
- Under 240 characters
- Not pushy
- Sounds like a real person
- Reference that I reached out about the listing at ${lead.address}
- Ask if they still need media or a backup option

Lead:
${JSON.stringify(lead, null, 2)}
`);
}

async function generateFollowUpEmail(lead) {
  return aiText(`
Write a short follow-up email for AirCamX.

Rules:
- Include subject line
- Friendly and human
- Not pushy
- Reference the listing at ${lead.address}
- Mention photos/drone/video/3D tour only briefly
- Ask if they still need help

Lead:
${JSON.stringify(lead, null, 2)}
`);
}

async function getAllLeads() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:S`
  });

  const rows = response.data.values || [];
  return rows.map(rowToLead);
}

async function appendLead(lead) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:S`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [leadToRow(lead)]
    }
  });
}

async function updateLeadInSheet(id, updates) {
  const leads = await getAllLeads();
  const index = leads.findIndex(l => l.id === id);

  if (index === -1) return null;

  const updatedLead = {
    ...leads[index],
    ...updates
  };

  if (updates.status === "messaged") {
    updatedLead.last_message_date = todayISO();
    updatedLead.next_follow_up = addDaysISO(3);
    updatedLead.follow_up_sms = await generateFollowUpSMS(updatedLead);
    updatedLead.follow_up_email = await generateFollowUpEmail(updatedLead);
  }

  if (updates.status === "follow_up") {
    updatedLead.last_message_date = todayISO();
    updatedLead.next_follow_up = addDaysISO(3);
    updatedLead.follow_up_sms = await generateFollowUpSMS(updatedLead);
    updatedLead.follow_up_email = await generateFollowUpEmail(updatedLead);
  }

  const rowNumber = index + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A${rowNumber}:S${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [leadToRow(updatedLead)]
    }
  });

  return rowToLead(leadToRow(updatedLead));
}

async function parseListingUrl(url) {
  const response = await axios.get(url, {
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0"
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

  return {
    listing_url: url,
    address: title.split("|")[0]?.trim() || "Review URL manually",
    city: "",
    price,
    agent_name: "",
    agent_phone: "",
    agent_email: "",
    photo_count: $("img").length || "",
    status: "needs_review",
    notes: "Imported from URL. Review missing fields."
  };
}

app.get("/api/leads", async (req, res) => {
  try {
    const leads = await getAllLeads();
    res.json({ total: leads.length, leads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/load", async (req, res) => {
  try {
    const leads = await getAllLeads();
    res.json({ success: true, total: leads.length, leads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/add-lead", async (req, res) => {
  try {
    const data = req.body;

    const lead = {
      id: crypto.randomUUID(),
      address: data.address || "",
      city: data.city || "",
      price: data.price || "",
      agent_name: data.agent_name || "",
      agent_phone: data.agent_phone || "",
      agent_email: data.agent_email || "",
      photo_count: data.photo_count || "",
      listing_url: data.listing_url || "",
      status: "new",
      sms: "",
      email: "",
      follow_up_sms: "",
      follow_up_email: "",
      last_message_date: "",
      next_follow_up: "",
      notes: data.notes || "",
      deal_value: data.deal_value || "",
      created_at: todayISO()
    };

    lead.sms = await generateInitialSMS(lead);
    lead.email = await generateInitialEmail(lead);

    await appendLead(lead);

    res.json({ success: true, lead: rowToLead(leadToRow(lead)) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/import-urls", async (req, res) => {
  try {
    const { urls } = req.body;
    const imported = [];

    for (const url of urls || []) {
      try {
        const parsed = await parseListingUrl(url);

        const lead = {
          id: crypto.randomUUID(),
          ...parsed,
          sms: "",
          email: "",
          follow_up_sms: "",
          follow_up_email: "",
          last_message_date: "",
          next_follow_up: "",
          deal_value: "",
          created_at: todayISO()
        };

        lead.sms = await generateInitialSMS(lead);
        lead.email = await generateInitialEmail(lead);

        await appendLead(lead);
        imported.push(rowToLead(leadToRow(lead)));
      } catch {
        const lead = {
          id: crypto.randomUUID(),
          address: "Review URL manually",
          city: "",
          price: "",
          agent_name: "",
          agent_phone: "",
          agent_email: "",
          photo_count: "",
          listing_url: url,
          status: "needs_review",
          sms: "Review this lead manually, then send a personal message.",
          email: "",
          follow_up_sms: "",
          follow_up_email: "",
          last_message_date: "",
          next_follow_up: "",
          notes: "URL could not be read automatically.",
          deal_value: "",
          created_at: todayISO()
        };

        await appendLead(lead);
        imported.push(rowToLead(leadToRow(lead)));
      }
    }

    res.json({ success: true, total: imported.length, leads: imported });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch("/api/leads/:id", async (req, res) => {
  try {
    const updated = await updateLeadInSheet(req.params.id, req.body);

    if (!updated) {
      return res.status(404).json({ success: false, error: "Lead not found" });
    }

    res.json({ success: true, lead: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => {
  console.log(`AirCamX CRM running on port ${PORT}`);
});