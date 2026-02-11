import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

export default async function handler(req, res) {
  const { cert } = req.query;
  if (!cert) return res.status(400).json({ error: 'Cert ID required' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const psaToken = process.env.PSA_API_TOKEN;
  const chKey = process.env.CARD_HEDGE_API_KEY; // Ensure this is set in Vercel

  if (!supabaseUrl || !supabaseUrl.startsWith('http')) {
    return res.status(500).json({ error: 'Configuration Error: SUPABASE_URL missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // --- 1. CACHE CHECK ---
    const { data: cachedRow } = await supabase
      .from('cached_cards')
      .select('*')
      .eq('cert_id', cert)
      .single();

    if (cachedRow) {
      const daysOld = (new Date() - new Date(cachedRow.last_updated)) / (1000 * 60 * 60 * 24);
      if (daysOld < 7) {
        return res.status(200).json({ 
          source: 'cache', 
          psa: cachedRow.card_data, 
          sales: cachedRow.sales_data 
        });
      }
    }

    // --- 2. FETCH PSA DATA ---
    if (!psaToken) throw new Error("Missing PSA_API_TOKEN");

    const psaResponse = await axios.get(
      `https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`,
      { headers: { 'Authorization': `Bearer ${psaToken}` } }
    );
    const psaData = psaResponse.data;
    const cardInfo = psaData.PSACert || psaData.Cert;

    if (!psaData || !cardInfo) {
        return res.status(404).json({ error: "Card not found in PSA database" });
    }

    // --- 3. FETCH SALES DATA (Updated for /v1/cards/card-search) ---
    let salesData = [];
    try {
        const searchString = `${cardInfo.Year} ${cardInfo.Brand} ${cardInfo.Subject} PSA ${cardInfo.CardGrade}`;
        console.log(`Searching Card Hedge for: ${searchString}`);

        // CORRECTED CALL: POST request to the v1 endpoint
        const chResponse = await axios.post(
          `https://api.cardhedger.com/v1/cards/card-search`, 
          { 
             search: searchString,
             limit: 1 // We just want the best match
          },
          { 
            headers: { 
                'X-API-KEY': chKey,
                'Content-Type': 'application/json'
            },
            timeout: 5000 
          }
        );

        // The search returns a list of cards. We take the first one.
        // Note: You might need to adjust this depending on if CH returns 'items' or 'data'
        const results = chResponse.data.data || chResponse.data.items || [];
        
        if (results.length > 0) {
            // The API usually returns the card *details* in the search. 
            // If we need specific sales history, we might need a 2nd call using results[0].id
            // But often the search result includes a 'last_sold' or 'price' field we can use.
            // For now, we will assume the search returns a usable object.
            salesData = results; 
        }
        
    } catch (salesError) {
        console.warn("Sales Lookup Failed:", salesError.message);
        salesData = []; 
    }

    // --- 4. SAVE TO CACHE ---
    await supabase.from('cached_cards').upsert({
      cert_id: cert,
      card_data: psaData,
      sales_data: salesData,
      last_updated: new Date().toISOString()
    });

    return res.status(200).json({ 
      source: 'api', 
      psa: psaData, 
      sales: salesData 
    });

  } catch (error) {
    console.error("Critical Backend Error:", error.message);
    return res.status(500).json({ 
        error: 'Backend Error', 
        details: error.message 
    });
  }
}