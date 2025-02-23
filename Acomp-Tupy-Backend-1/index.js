const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const xml2js = require('xml2js');
require('dotenv').config();

const app = express();
const port = 3000;

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware to parse JSON
app.use(express.json());

//HAPAG
async function fetchHapagDate(bookingCode) {
  const carrierApiUrl = `https://api.hlag.com/hlag/external/v2/events/?carrierBookingReference=${bookingCode}`; // Replace with actual API endpoint
  const headers = {
    'Accept': 'application/json',
    'X-IBM-Client-Id': `${process.env.HAPAG_CLIENT_ID}`,
    'X-IBM-Client-Secret': `${process.env.HAPAG_API_KEY}`,
  };

  try {
    const response = await axios.get(carrierApiUrl, { headers });
    const events = response.data;

    // Find the ETD (Departure event)
    const departureEvent = events.find(
      (event) =>
        event.eventType === "TRANSPORT" &&
        event.transportEventTypeCode === "DEPA"
    );

    if (departureEvent) {
      return departureEvent.eventDateTime; // Return the ETD
    } else {
      console.log("No ETD found for booking code:", bookingCode);
      return null;
    }
  } catch (error) {
    console.error("Error fetching shipment date:", error.message);
    return null;
  }
}

// MAERSK
async function fetchMSKDate(bookingCode) {
  const carrierApiUrl = `https://api.hlag.com/hlag/external/v2/events/?carrierBookingReference=${bookingCode}`; // Replace with actual API endpoint
  const headers = {
    'Accept': 'application/json',
    'X-IBM-Client-Id': `${process.env.HAPAG_CLIENT_ID}`,
    'X-IBM-Client-Secret': `${process.env.HAPAG_API_KEY}`,
  };

  try {
    const response = await axios.get(carrierApiUrl, { headers });
    const events = response.data;

    // Find the ETD (Departure event)
    const departureEvent = events.find(
      (event) =>
        event.eventType === "TRANSPORT" &&
        event.transportEventTypeCode === "DEPA"
    );

    if (departureEvent) {
      return departureEvent.eventDateTime; // Return the ETD
    } else {
      console.log("No ETD found for booking code:", bookingCode);
      return null;
    }
  } catch (error) {
    console.error("Error fetching shipment date:", error.message);
    return null;
  }
}

async function getmsktoken() {
  const url = "https://api.maersk.com/customer-identity/oauth/v2/access_token";
  const appConsumerKey = "vPyl7ES1vIST98PbliklSJEwni4MFfvw";
  const appClientSecret = "V9GuOAQ41QDqeM6Y";

  const headers = {
    'Cache-Control': 'no-cache',
    'Consumer-Key': appConsumerKey,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appConsumerKey,
    client_secret: appClientSecret,
  }).toString();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: body,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.access_token; 
  } catch (error) {
    console.error('Error fetching access token:', error);
    return null;
  }
}

//Position
async function getVesselPosition(vessel_name) {
  const mmsi = await getvesselmmsi(vessel_name);
  
  const url = `https://www.myshiptracking.com/requests/vesselonmap.php?type=json&mmsi=${mmsi}&_=${Date.now()}`;
  
  
  try {
    const response = await axios.get(url);
    const posi = response.data.split('\t');
    return posi; // Return the JSON response
  } catch (error) {
    console.error('Error fetching vessel position:', error.message);
    throw error; // Rethrow the error for further handling
  }
}

async function getvesselmmsi(vessel_name) {
  const url = `https://www.myshiptracking.com/requests/autocomplete.php?req=${encodeURIComponent(vessel_name)}&res=all`;

    try {
      const response = await axios.get(url);
      const results = response.data;

      // Parse the XML response
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(results);
      
      // Check if results exist
      if (result.RESULTS && result.RESULTS.RES) {
        const vessels = result.RESULTS.RES;

        // Iterate through the vessels to find a container ship
        for (let i = 0; i < vessels.length; i++) {
          const type = vessels[i].D[0]; // Assuming D is the type
          const mmsi = vessels[i].ID[0]; // Assuming ID is the MMSI

          if (type === "Container Ship" || type === "Cargo" || type === "Cargo A" || type === "Cargo B" || type === "Cargo C") {
            return mmsi; // Return the MMSI of the container ship
          }
        }
      }

      return null; // Return null if no container ship is found
    } catch (error) {
      console.error('Error fetching MMSI by vessel name:', error.message);
      throw error; // Rethrow the error for further handling
    }
  }


// Route to update shipment dates in the database
app.post("/update-shipments", async (req, res) => {
  const { table } = req.body;

  if (!table) {
    return res.status(400).json({ error: "Table name is required" });
  }

  try {
    // Fetch all records from the table
    const { data: records, error: fetchError } = await supabase
      .from(table)
      .select("*");

    if (fetchError) {
      throw fetchError;
    }

    // Iterate through records and update ETD
    for (const record of records) {
      const id = record.id;
      const bookingCode = record.booking_code;
      const vessel_name = record.vessel_name;
      //Get vessels position
      
      const vesselPosition = await getVesselPosition(vessel_name);

      if (vesselPosition.length > 2) {
        const { error: updatePError } = await supabase
          .from(table)
          .update({ latitude: vesselPosition[0], longitude: vesselPosition[1] })
          .eq("id", id);
  
        if (updatePError) {
          console.error("Error updating record:", updatePError.message);
        } else {
          console.log(`Updated record ${id}`);
        }
      }
    
      // Check if Booking_code has a length of 8
      if (bookingCode.length === 8) {
        // Fetch ETD from carrier API
        const etd = await fetchHapagDate(bookingCode);
  
        if (etd) {
          // Update the record in Supabase
          const { error: updateError } = await supabase
            .from(table)
            .update({ etd: etd })
            .eq("id", id);
  
          if (updateError) {
            console.error("Error updating record:", updateError.message);
          } else {
            console.log(`Updated record ${id} with ETD: ${etd}`);
          }
        }
      }
    }

    res.status(200).json({ message: "ETDs updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

const cron = require("node-cron");

// Roda diariamente às  9h e 15h
cron.schedule("0 9,15 * * *", async () => {
  console.log("Running scheduled task to update ETDs...");
  try {
    // Call the /update-shipments endpoint
    await axios.post("http://localhost:3000/update-shipments", {
      table: "shipments",
    });
    console.log("ETDs updated successfully.");
  } catch (error) {
    console.error("Error updating ETDs:", error.message);
  }
});