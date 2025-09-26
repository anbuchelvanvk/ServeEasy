const express = require('express');
const admin = require('firebase-admin');
const chrono = require('chrono-node');

// --- INITIALIZATION ---
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://serveeasy-8565e-default-rtdb.asia-southeast1.firebasedatabase.app"
  });
} catch (error) {
  console.error("Firebase initialization failed. Make sure your FIREBASE_SERVICE_ACCOUNT_JSON environment variable is set correctly.", error);
}

const db = admin.database();
const app = express();
app.use(express.json());


// --- MAIN HANDLER / ROUTER ---
app.post('/api/handler', async (req, res) => {
  const task = req.body.task;
  console.log(`\n--- Received task: ${task} ---`);
  
  try {
    switch (task) {
      // Scheduling
      case "findAvailableSlots":
        return await handleFindAvailableSlots(req, res);

      // Ticketing (CRUD)
      case "createTicket":
        return await handleCreateTicket(req, res);
      case "getTicket":
        return await handleGetTicket(req, res);
      case "updateTicket":
        return await handleUpdateTicket(req, res);
      case "cancelTicket":
        return await handleCancelTicket(req, res);

      // Customer/Region Lookups
      case "getCustomerByPhone":
        return await handleGetCustomerByPhone(req, res);
      case "getRegionByKey":
        return await handleGetRegionByKey(req, res);

      default:
        return res.status(400).send({ error: "Invalid task specified" });
    }
  } catch (error) {
    console.error(`Error processing task "${task}":`, error);
    return res.status(500).send({ error: "An internal server error occurred." });
  }
});


// --- TASK LOGIC FUNCTIONS ---

async function handleFindAvailableSlots(req, res) {
  const { region, skill, appliance, preferred_time_phrase } = req.body;
  console.log("Inputs Received:", { region, skill, appliance, preferred_time_phrase });

  const dateInfo = getDateInfo(preferred_time_phrase);
  if (!dateInfo) {
    return res.status(400).send({ error: "Invalid or past date specified. Please provide a future date." });
  }
  const { dateString, dayOfWeek, timeWindow } = dateInfo;
  console.log("Calculated Date Info:", { dateString, dayOfWeek, timeWindow });

  const skilledTechsSnap = await db.ref(`/techniciansBySkill/${skill}`).once("value");
  if (!skilledTechsSnap.exists()) return res.status(200).send({ slots: [] });
  
  const potentialTechIds = Object.keys(skilledTechsSnap.val());
  let allAvailableSlots = [];
  const appointmentsSnap = await db.ref(`/appointments/${dateString}`).once("value");
  const todaysAppointments = appointmentsSnap.val() || {};

  for (const techId of potentialTechIds) {
    const techSnap = await db.ref(`/technicians/${techId}`).once("value");
    const technician = techSnap.val();
    if (!technician) continue;

    if (technician.TechRegion === region && technician.appliances_supported.includes(appliance)) {
      const workingHours = technician.working_hours[dayOfWeek];
      if (workingHours && workingHours !== "none") {
        const bookedSlots = todaysAppointments[techId] || [];
        const freeSlots = calculateFreeSlots(workingHours, bookedSlots);
        
        for (const slotTime of freeSlots) {
          allAvailableSlots.push({ time: slotTime, techId: techId, techName: technician.TechName });
        }
      }
    }
  }

  // Filter slots by the user's preferred time window (e.g., "afternoon")
  const filteredSlots = allAvailableSlots.filter(slot => {
    const slotStart = timeToMinutes(slot.time.split('-')[0]);
    return slotStart >= timeWindow.start && slotStart < timeWindow.end;
  });

  console.log("Final filtered slots to be returned:", filteredSlots);
  return res.status(200).send({ slots: filteredSlots.slice(0, 4) });
}

async function handleCreateTicket(req, res) {
    const { dateString, slot, customerInfo, jobInfo } = req.body;
    console.log(`Creating ticket for Tech: ${slot.techId} on ${dateString}`);
  
    const techSnap = await db.ref(`/technicians/${slot.techId}`).once("value");
    if (!techSnap.exists()) return res.status(404).send({ error: "Technician not found." });
    const technician = techSnap.val();
  
    const ticketId = `SR-${Date.now()}`;
    const [startTime, endTime] = slot.time.split('-');
  
    const ticketData = {
      ticketId, status: "Booked", createdAt: new Date().toISOString(),
      CustName: customerInfo.name, CustPhone: customerInfo.phone, CustAddress: customerInfo.address,
      TechId: slot.techId, TechName: slot.techName, TechPhone: technician.TechPhone,
      appointmentDate: dateString, appointmentTime: slot.time,
      appliance: jobInfo.appliance, description: jobInfo.description
    };
  
    const appointmentPointer = { start: startTime, end: endTime, ticketId };
  
    const updates = {};
    const newAppointmentRef = db.ref(`/appointments/${dateString}/${slot.techId}`).push();
    updates[`/tickets/${ticketId}`] = ticketData;
    updates[`/appointments/${dateString}/${slot.techId}/${newAppointmentRef.key}`] = appointmentPointer;
  
    await db.ref().update(updates);
    console.log(`Ticket created: ${ticketId}`);
    return res.status(200).send({ status: "confirmed", ticketId });
}

async function handleGetTicket(req, res) {
    const { ticketId } = req.body;
    console.log(`Fetching ticket: ${ticketId}`);
    const ticketSnap = await db.ref(`/tickets/${ticketId}`).once("value");
    if (!ticketSnap.exists()) return res.status(404).send({ error: "Ticket not found." });
    return res.status(200).send({ ticket: ticketSnap.val() });
}

async function handleUpdateTicket(req, res) {
    const { ticketId, updates } = req.body; // updates is an object like {"status": "Completed"}
    console.log(`Updating ticket ${ticketId} with:`, updates);
    const ticketRef = db.ref(`/tickets/${ticketId}`);
    await ticketRef.update(updates);
    return res.status(200).send({ status: "updated", ticketId });
}

async function handleCancelTicket(req, res) {
    const { ticketId } = req.body;
    console.log(`Cancelling ticket: ${ticketId}`);
    // We don't delete tickets, we change their status. This preserves history.
    const ticketRef = db.ref(`/tickets/${ticketId}`);
    await ticketRef.update({ status: "Cancelled" });

    // You would also add logic here to remove the appointment from the /appointments node
    // to free up the technician's slot.

    return res.status(200).send({ status: "cancelled", ticketId });
}

// ... other handlers like handleGetCustomerByPhone, handleGetRegionByKey ...


// --- HELPER FUNCTIONS ---

function getDateInfo(phrase) {
  const referenceDate = new Date(); // Use server's current time
  const parsedResult = chrono.parse(phrase, referenceDate, { forwardDate: true });

  if (!parsedResult || parsedResult.length === 0) return null; // Couldn't understand phrase

  const targetDate = parsedResult[0].start.date();
  
  // Define time windows
  const timeWindows = {
    morning: { start: 9 * 60, end: 12 * 60 },   // 9 AM - 12 PM
    afternoon: { start: 12 * 60, end: 17 * 60 }, // 12 PM - 5 PM
    evening: { start: 17 * 60, end: 21 * 60 }    // 5 PM - 9 PM
  };
  
  let timeWindow = { start: 0, end: 24 * 60 }; // Default to full day
  const phraseLower = phrase.toLowerCase();
  if (phraseLower.includes('morning')) timeWindow = timeWindows.morning;
  if (phraseLower.includes('afternoon')) timeWindow = timeWindows.afternoon;
  if (phraseLower.includes('evening')) timeWindow = timeWindows.evening;

  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  
  return {
      dateString: `${targetDate.getFullYear()}-${(targetDate.getMonth() + 1).toString().padStart(2, '0')}-${targetDate.getDate().toString().padStart(2, '0')}`,
      dayOfWeek: dayNames[targetDate.getDay()],
      timeWindow: timeWindow
  };
}

// ... other helpers like calculateFreeSlots, timeToMinutes, etc. ...


// --- START THE SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});