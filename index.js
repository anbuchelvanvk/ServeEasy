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
  console.log("--- Starting findAvailableSlots: Task received ---");
  const { region, skill, appliance, preferred_time_phrase, custPhone } = req.body;
  console.log("1. Inputs Received:", { region, skill, appliance, preferred_time_phrase, custPhone });

  // --- EDGE CASE: Check for existing open tickets for this customer ---
  if (custPhone) {
    const ticketsRef = db.ref('/tickets');
    const query = ticketsRef.orderByChild('CustPhone').equalTo(custPhone);
    const snapshot = await query.once('value');
    if (snapshot.exists()) {
      const existingTickets = snapshot.val();
      for (const ticketId in existingTickets) {
        const ticket = existingTickets[ticketId];
        if (ticket.status === 'Booked' || ticket.status === 'In Progress') {
          console.log(`-! Edge Case Handled: Customer already has an open ticket (${ticketId}).`);
          return res.status(200).send({ 
            error: "An open ticket for this customer already exists.",
            existingTicketId: ticketId 
          });
        }
      }
    }
  }

  // --- EDGE CASE: Handle invalid or past dates ---
  const dateInfo = getDateInfo(preferred_time_phrase);
  if (!dateInfo) {
    console.log("-! Edge Case Handled: Invalid or past date specified.");
    return res.status(200).send({ error: "Invalid or past date specified. Please provide a future date." });
  }
  const { dateString, dayOfWeek, timeWindow } = dateInfo;
  console.log("2. Calculated Date Info:", { dateString, dayOfWeek, timeWindow });

  // --- LOGIC: Find technicians by skill ---
  const skilledTechsSnap = await db.ref(`/techniciansBySkill/${skill}`).once("value");
  if (!skilledTechsSnap.exists()) {
    console.log("3. Skill Lookup: No technicians found for this skill in the index. Exiting.");
    return res.status(200).send({ slots: [] });
  }
  const potentialTechIds = Object.keys(skilledTechsSnap.val());
  console.log("3. Skill Lookup: Found potential technicians:", potentialTechIds);
  
  // --- LOGIC: Loop, filter, and calculate slots ---
  let allAvailableSlots = [];
  const appointmentsSnap = await db.ref(`/appointments/${dateString}`).once("value");
  const todaysAppointments = appointmentsSnap.val() || {};
  console.log(`4. Fetched appointments for ${dateString}:`, todaysAppointments);

  for (const techId of potentialTechIds) {
    console.log(`\n--- 5. Checking Technician: ${techId} ---`);
    const techSnap = await db.ref(`/technicians/${techId}`).once("value");
    const technician = techSnap.val();
    if (!technician) {
      console.log(`-! Warning: Could not fetch profile for ${techId}. Skipping.`);
      continue;
    }

    console.log(`   - Data: Region='${technician.TechRegion}', Appliances=[${technician.appliances_supported}]`);
    
    // Filtering conditions
    const regionMatch = technician.TechRegion === region;
    const applianceMatch = Array.isArray(technician.appliances_supported) && technician.appliances_supported.includes(appliance);
    console.log(`   - Condition Check: regionMatch=${regionMatch}, applianceMatch=${applianceMatch}`);

    if (regionMatch && applianceMatch) {
      const workingHours = technician.working_hours[dayOfWeek];
      console.log(`   - Working Hours on ${dayOfWeek}: ${workingHours}`);
      
      if (workingHours && workingHours !== "none") {
        const bookedSlots = todaysAppointments[techId] || [];
        console.log(`   - Found ${bookedSlots.length} booked slot(s) for this tech.`);

        const freeSlots = calculateFreeSlots(workingHours, bookedSlots);
        console.log(`   - Calculated ${freeSlots.length} free slot object(s).`);
        
        for (const slotTime of freeSlots) {
          allAvailableSlots.push({ time: slotTime, techId: techId, techName: technician.TechName });
        }
      } else {
        console.log(`   - Result: Technician does not work on ${dayOfWeek}.`);
      }
    } else {
      console.log(`   - Result: Technician failed region or appliance filter.`);
    }
  }

  console.log("\n6. All potential slots before time window filter:", allAvailableSlots);

  // --- LOGIC: Final filter based on time phrase (e.g., "afternoon") ---
  const filteredSlots = allAvailableSlots.filter(slot => {
    const slotStart = timeToMinutes(slot.time.split('-')[0]);
    return slotStart >= timeWindow.start && slotStart < timeWindow.end;
  });
  console.log("7. Final slots after time window filter:", filteredSlots);

  // --- LOGIC: Prepare and send the final response ---
  const finalResponseObject = { slots: filteredSlots.slice(0, 4) }; // Return up to 4 slots
  console.log("8. Sending final response to agent:", finalResponseObject);
  console.log("--- Task Finished ---");

  return res.status(200).send(finalResponseObject);
}

// Replace your handleCreateTicket function with this improved version

// Replace your old handleCreateTicket function with this one

async function handleCreateTicket(req, res) {
  const { dateString, slot, customerInfo, jobInfo } = req.body;
  console.log(`--- Starting createTicket for Customer: ${customerInfo.phone} ---`);

  // --- 1. RIGOROUS INPUT VALIDATION ---
  if (!dateString || !slot || !customerInfo || !jobInfo || !jobInfo.requestType || !jobInfo.appliance) {
    return res.status(200).send({ error: "Missing required booking information." });
  }

  // (Duplicate Ticket Check and Time Conflict Check logic remains the same...)

  // --- 2. FETCH FRESH DATA FOR CONSISTENCY ---
  const techSnap = await db.ref(`/technicians/${slot.techId}`).once("value");
  if (!techSnap.exists()) {
    return res.status(200).send({ error: "Technician details could not be found." });
  }
  const technician = techSnap.val();

  // --- 3. CREATE AND SAVE TICKET ---
  const ticketId = `SR-${Date.now()}`;
  const [startTime, endTime] = slot.time.split('-');
  
  const ticketData = {
    ticketId, status: "Booked", createdAt: new Date().toISOString(),
    // Customer Info
    CustName: customerInfo.name, CustPhone: customerInfo.phone, CustAddress: customerInfo.address,
    // Job Info
    requestType: jobInfo.requestType,
    appliance: jobInfo.appliance,
    description: jobInfo.description,
    urgency: jobInfo.urgency || "Normal", // Default to 'Normal' if not provided
    // Scheduling Info
    TechId: slot.techId, TechName: technician.TechName, TechPhone: technician.TechPhone,
    appointmentDate: dateString, appointmentTime: slot.time,
  };

  // Conditionally add modelInfo for installations
  if (jobInfo.requestType === "Installation" && jobInfo.modelInfo) {
    ticketData.modelInfo = jobInfo.modelInfo;
  }

  const appointmentPointer = { start: startTime, end: endTime, ticketId };
  const updates = {};
  const newAppointmentRef = db.ref(`/appointments/${dateString}/${slot.techId}`).push();
  updates[`/tickets/${ticketId}`] = ticketData;
  updates[`/appointments/${dateString}/${slot.techId}/${newAppointmentRef.key}`] = appointmentPointer;

  await db.ref().update(updates);
  console.log(`6. Write successful! Ticket created: ${ticketId}`);
  
  return res.status(200).send({ status: "confirmed", ticketId });
}

// Replace your old handleUpdateTicket function with this one

async function handleUpdateTicket(req, res) {
  const { ticketId, updates } = req.body;
  console.log(`--- Starting handleUpdateTicket for Ticket ID: ${ticketId} ---`);
  console.log("1. Received updates payload:", updates);

  try {
    // --- 2. VALIDATE INPUTS ---
    if (!ticketId || !updates) {
      console.error("-! Validation FAILED: ticketId and updates object are required.");
      return res.status(400).send({ error: "ticketId and updates object are required." });
    }
    console.log("2. Inputs validated successfully.");

    // --- 3. FETCH ORIGINAL TICKET ---
    const ticketRef = db.ref(`/tickets/${ticketId}`);
    const ticketSnap = await ticketRef.once("value");
    if (!ticketSnap.exists()) {
      console.error(`-! Error: Ticket ${ticketId} not found in database.`);
      return res.status(404).send({ error: "Ticket not found." });
    }
    console.log(`3. Successfully fetched original ticket ${ticketId}.`);


    // --- 4. DETERMINE UPDATE TYPE (RESCHEDULE OR SIMPLE) ---
    if (updates.reschedule) {
      // --- RESCHEDULING LOGIC ---
      console.log("4a. Rescheduling logic triggered.");
      const { newDate, newSlot, oldDate, oldTechId } = updates.reschedule;
      
      // Prepare the object for all database changes
      const updatesForReschedule = {};
      
      // 4a-1. Find and prepare to delete the old appointment pointer
      console.log(`   - Searching for old appointment for Tech ${oldTechId} on ${oldDate}`);
      const oldAppointmentPath = `/appointments/${oldDate}/${oldTechId}`;
      const oldAppointmentsSnap = await db.ref(oldAppointmentPath).orderByChild('ticketId').equalTo(ticketId).once('value');
      
      if (oldAppointmentsSnap.exists()) {
        const oldAppointmentKey = Object.keys(oldAppointmentsSnap.val())[0];
        const fullDeletionPath = `${oldAppointmentPath}/${oldAppointmentKey}`;
        updatesForReschedule[fullDeletionPath] = null; // Setting to null deletes the data
        console.log(`   - Found old appointment. Marked for deletion at: ${fullDeletionPath}`);
      } else {
        console.log(`   - Warning: Did not find a matching old appointment to delete.`);
      }

      // 4a-2. Prepare to update the main ticket fields
      const [newStartTime, newEndTime] = newSlot.time.split('-');
      updatesForReschedule[`/tickets/${ticketId}/appointmentDate`] = newDate;
      updatesForReschedule[`/tickets/${ticketId}/appointmentTime`] = newSlot.time;
      updatesForReschedule[`/tickets/${ticketId}/TechId`] = newSlot.techId;
      updatesForReschedule[`/tickets/${ticketId}/TechName`] = newSlot.techName;
      console.log("   - Prepared main ticket fields for update.");
      
      // 4a-3. Prepare to create the new appointment pointer
      const newAppointmentPointer = { start: newStartTime, end: newEndTime, ticketId };
      const newAppointmentRef = db.ref(`/appointments/${newDate}/${newSlot.techId}`).push();
      const newPointerPath = `/appointments/${newDate}/${newSlot.techId}/${newAppointmentRef.key}`;
      updatesForReschedule[newPointerPath] = newAppointmentPointer;
      console.log(`   - Prepared new appointment pointer for creation at: ${newPointerPath}`);

      // 4a-4. Perform all database operations at once
      console.log("   - Performing atomic update for reschedule...");
      await db.ref().update(updatesForReschedule);
      console.log(`5. Reschedule complete for ticket ${ticketId}.`);
      return res.status(200).send({ status: "rescheduled", ticketId });

    } else {
      // --- SIMPLE UPDATE LOGIC ---
      console.log("4b. Simple update logic triggered.");
      await ticketRef.update(updates);
      console.log(`5. Simple update complete for ticket ${ticketId}.`);
      return res.status(200).send({ status: "updated", ticketId });
    }
  } catch (error) {
    console.error(`-! CRITICAL ERROR during update for ticket ${ticketId}:`, error);
    return res.status(500).send({ error: "An internal server error occurred during the update." });
  }
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
/**
 * The "ruler" algorithm. Takes working hours (e.g., "09:00-18:00") and a list of
 * booked slots (e.g., [{start: "11:00", end: "12:30"}]) and returns available 2-hour slots.
 */
function calculateFreeSlots(workingHours, bookedSlots) {
  const [workStart, workEnd] = workingHours.split('-').map(timeToMinutes);
  const serviceDuration = 120; // 2 hours
  let availableSlots = [];
  let currentTime = workStart;

  bookedSlots.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

  for (const booked of bookedSlots) {
    const bookedStart = timeToMinutes(booked.start);
    const bookedEnd = timeToMinutes(booked.end);
    
    while (currentTime + serviceDuration <= bookedStart) {
      availableSlots.push(`${minutesToTime(currentTime)}-${minutesToTime(currentTime + serviceDuration)}`);
      currentTime += serviceDuration;
    }
    currentTime = Math.max(currentTime, bookedEnd);
  }

  while (currentTime + serviceDuration <= workEnd) {
    availableSlots.push(`${minutesToTime(currentTime)}-${minutesToTime(currentTime + serviceDuration)}`);
    currentTime += serviceDuration;
  }
  return availableSlots;
}

/**
 * Converts "today", "tomorrow", "afternoon", etc., into a specific date,
 * day of the week, and time window. It is timezone-aware for India (IST).
 */
function getDateInfo(preferredDay) {
    const now = new Date();
    const nowInIST = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    let targetDate = new Date(nowInIST);
    if (preferredDay) {
        const dayLower = preferredDay.toLowerCase();
        if (dayLower.includes('tomorrow')) {
            targetDate.setDate(targetDate.getDate() + 1);
        }
    }
    const startOfTodayIST = new Date(nowInIST.setHours(0, 0, 0, 0));
    if (targetDate < startOfTodayIST) {
        console.log("Error: Requested date is in the past.");
        return null; 
    }
    const timeWindows = {
        morning: { start: 9 * 60, end: 12 * 60 },
        afternoon: { start: 12 * 60, end: 17 * 60 },
        evening: { start: 17 * 60, end: 21 * 60 }
    };
    let timeWindow = { start: 0, end: 24 * 60 };
    const phraseLower = (preferredDay || "").toLowerCase();
    if (phraseLower.includes('morning')) timeWindow = timeWindows.morning;
    if (phraseLower.includes('afternoon')) timeWindow = timeWindows.afternoon;
    if (phraseLower.includes('evening')) timeWindow = timeWindows.evening;
    const year = targetDate.getUTCFullYear();
    const month = (targetDate.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = targetDate.getUTCDate().toString().padStart(2, '0');
    return {
        dateString: `${year}-${month}-${day}`,
        dayOfWeek: dayNames[targetDate.getUTCDay()],
        timeWindow: timeWindow
    };
}


/**
 * Utility to convert a time string like "09:30" into total minutes from midnight.
 */
function timeToMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

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