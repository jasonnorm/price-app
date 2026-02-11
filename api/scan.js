// /api/scan.js
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

// Initialize Supabase (Database)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  // 1. Get Cert ID from Frontend
  const { cert } = req.query;
  if (!cert) return res.status(400).json({ error: 'Cert ID required' });

  try {
    // ---------------------------------------------------------
    // STEP A: Check Cache (Database)
    // ---------------------------------------------------------
    const { data: cachedRow, error: dbError } = await supabase
      .from('cached_cards')
      .select('*')
      .eq('cert_id', cert)
      .single();

    // If found and less than 7 days old, return cached data!
    if (cachedRow) {
      const daysOld = (new Date() - new Date(cachedRow.last_updated)) / (1000 * 60 * 60 * 24);
      if (daysOld < 7) {
        console.log("Serving from Cache");
        return res.status(200).json({ 
          source: 'cache', 
          psa: cachedRow.card_data, 
          sales: cachedRow.sales_data 
        });
      }
    }

    // ---------------------------------------------------------
    // STEP B: Fetch Real Data (APIs)
    // ---------------------------------------------------------
    console.log("Cache miss. Fetching from APIs...");

    // 1. Call PSA API
    const psaResponse = await axios.get(
      `https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`,
      { headers: { 'Authorization': `Bearer ${process.env.PSA_API_TOKEN}` } }
    );
    const psaData = psaResponse.data;

    // 2. Call Card Hedge API (Sales Data)
    const searchString = `${psaData.Cert.Year} ${psaData.Cert.Brand} ${psaData.Cert.Subject} PSA ${psaData.Cert.CardGrade}`;
    const chResponse = await axios.get(
      `https://api.cardhedge.com/v1/sales/search`, 
      { 
        params: { q: searchString },
        headers: { 'X-API-KEY': process.env.CARD_HEDGE_API_KEY } 
      }
    );
    const salesData = chResponse.data.data || [];

    // ---------------------------------------------------------
    // STEP C: Save to Cache (Upsert)
    // ---------------------------------------------------------
    await supabase.from('cached_cards').upsert({
      cert_id: cert,
      card_data: psaData,
      sales_data: salesData,
      last_updated: new Date().toISOString()
    });

    // Return Fresh Data
    return res.status(200).json({ 
      source: 'api', 
      psa: psaData, 
      sales: salesData 
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Server Error', details: error.message });
  }
}
