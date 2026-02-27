import express from "express";
import { createServer as createViteServer } from "vite";
import db, { initDb } from "./src/db.ts";
import path from "path";
import { fileURLToPath } from "url";
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.APP_URL}/auth/google/callback`
);

async function sendGmailReminder(userId: number, subject: string, body: string) {
  const user = db.prepare("SELECT google_access_token, google_refresh_token FROM users WHERE id = ?").get(userId);
  if (!user || !user.google_access_token) return;

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials({
    access_token: user.google_access_token,
    refresh_token: user.google_refresh_token
  });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    'From: BookMyCare <me>',
    'To: me',
    `Subject: ${utf8Subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
  ];
  const message = messageParts.join('\n');
  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });
    console.log(`Gmail reminder sent to user ${userId}`);
  } catch (error) {
    console.error('Error sending Gmail reminder:', error);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize Database
  initDb();

  // --- API ROUTES ---

  // Google OAuth: Get URL
  app.get("/api/auth/google/url", (req, res) => {
    const { userId } = req.query;
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email'],
      state: userId as string,
      prompt: 'consent'
    });
    res.json({ url });
  });

  // Google OAuth: Callback
  app.get("/auth/google/callback", async (req, res) => {
    const { code, state: userId } = req.query;
    try {
      const { tokens } = await oauth2Client.getToken(code as string);
      db.prepare("UPDATE users SET google_access_token = ?, google_refresh_token = ? WHERE id = ?")
        .run(tokens.access_token, tokens.refresh_token, userId);
      
      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/dashboard';
              }
            </script>
            <p>Google account connected successfully! You can close this window.</p>
          </body>
        </html>
      `);
    } catch (error) {
      res.status(500).send("Authentication failed");
    }
  });

  // Google OAuth: Status
  app.get("/api/auth/google/status/:userId", (req, res) => {
    const { userId } = req.params;
    const user = db.prepare("SELECT google_access_token FROM users WHERE id = ?").get(userId);
    res.json({ connected: !!(user && user.google_access_token) });
  });

  // Auth: Login
  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;
    console.log(`Login attempt for: ${email}`);
    
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND password = ?").get(email, password);
    
    if (user) {
      let fullUser = { ...user };
      if (user.role === 'patient') {
        const patientData = db.prepare("SELECT age, gender, blood_group, id as patientId FROM patients WHERE user_id = ?").get(user.id);
        fullUser = { ...fullUser, ...patientData };
      } else if (user.role === 'doctor') {
        const doctorData = db.prepare("SELECT *, id as doctorId FROM doctors WHERE user_id = ?").get(user.id);
        const { id, ...doctorDataWithoutId } = doctorData;
        fullUser = { ...fullUser, ...doctorDataWithoutId };
      }
      
      console.log(`Login successful for: ${email}`);
      res.json({ success: true, user: fullUser });
    } else {
      console.log(`Login failed for: ${email}`);
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  });

  // Auth: Register
  app.post("/api/auth/register", (req, res) => {
    const { name, email, password, role, phone, age, gender, specialization, degree, qualification, experience } = req.body;
    
    try {
      const insertUser = db.prepare("INSERT INTO users (name, email, password, role, phone) VALUES (?, ?, ?, ?, ?)");
      const result = insertUser.run(name, email, password, role, phone);
      const userId = result.lastInsertRowid;

      if (role === 'patient') {
        db.prepare("INSERT INTO patients (user_id, age, gender) VALUES (?, ?, ?)").run(userId, age, gender);
      } else if (role === 'doctor') {
        db.prepare("INSERT INTO doctors (user_id, specialization, degree, qualification, experience) VALUES (?, ?, ?, ?, ?)").run(userId, specialization, degree, qualification, experience || 0);
      }

      res.json({ success: true, userId });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  // Doctors: List all
  app.get("/api/doctors", (req, res) => {
    const doctors = db.prepare(`
      SELECT d.*, u.name, u.email, u.phone 
      FROM doctors d 
      JOIN users u ON d.user_id = u.id
    `).all();
    res.json(doctors);
  });

  // Doctors: Update
  app.put("/api/doctors/:id", (req, res) => {
    const { id } = req.params;
    const { name, phone, specialization, degree, qualification, experience, consultation_fee, bio } = req.body;
    
    try {
      const doctor = db.prepare("SELECT user_id FROM doctors WHERE id = ?").get(id);
      if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found" });

      db.prepare("UPDATE users SET name = ?, phone = ? WHERE id = ?").run(name, phone, doctor.user_id);
      db.prepare("UPDATE doctors SET specialization = ?, degree = ?, qualification = ?, experience = ?, consultation_fee = ?, bio = ? WHERE id = ?")
        .run(specialization, degree, qualification, experience, consultation_fee, bio, id);
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Doctors: Delete
  app.delete("/api/doctors/:id", (req, res) => {
    const { id } = req.params;
    try {
      const doctor = db.prepare("SELECT user_id FROM doctors WHERE id = ?").get(id);
      if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found" });

      db.prepare("DELETE FROM users WHERE id = ?").run(doctor.user_id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Appointments: Book
  app.post("/api/appointments", (req, res) => {
    const { patient_id, doctor_id, date, time } = req.body;
    
    // Check for double booking
    const existing = db.prepare("SELECT * FROM appointments WHERE doctor_id = ? AND date = ? AND time = ? AND status != 'cancelled'")
      .get(doctor_id, date, time);
    
    if (existing) {
      return res.status(400).json({ success: false, message: "This slot is already booked." });
    }

    try {
      const result = db.prepare("INSERT INTO appointments (patient_id, doctor_id, date, time) VALUES (?, ?, ?, ?)")
        .run(patient_id, doctor_id, date, time);
      
      // Send Gmail Reminder
      const doctor = db.prepare("SELECT u.name FROM doctors d JOIN users u ON d.user_id = u.id WHERE d.id = ?").get(doctor_id);
      sendGmailReminder(patient_id, "Appointment Booked - BookMyCare", `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; rounded: 12px;">
          <h2 style="color: #0284c7;">Appointment Confirmation</h2>
          <p>Your appointment with <strong>Dr. ${doctor.name}</strong> has been successfully booked.</p>
          <p><strong>Date:</strong> ${date}</p>
          <p><strong>Time:</strong> ${time}</p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
          <p style="font-size: 12px; color: #64748b;">This is an automated reminder from BookMyCare.</p>
        </div>
      `);

      res.json({ success: true, appointmentId: result.lastInsertRowid });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Appointments: Get for user
  app.get("/api/appointments/:userId", (req, res) => {
    const { userId } = req.params;
    const { role } = req.query;

    let query = "";
    if (role === 'patient') {
      query = `
        SELECT a.*, u.name as doctor_name, d.specialization, d.consultation_fee,
               (SELECT status FROM payments WHERE appointment_id = a.id LIMIT 1) as payment_status
        FROM appointments a
        JOIN doctors d ON a.doctor_id = d.id
        JOIN users u ON d.user_id = u.id
        WHERE a.patient_id = ?
        ORDER BY a.date DESC, a.time DESC
      `;
    } else if (role === 'doctor') {
      query = `
        SELECT a.*, u.name as patient_name,
               (SELECT status FROM payments WHERE appointment_id = a.id LIMIT 1) as payment_status
        FROM appointments a
        JOIN doctors d ON a.doctor_id = d.id
        JOIN users u ON a.patient_id = u.id
        WHERE d.user_id = ?
        ORDER BY a.date DESC, a.time DESC
      `;
    } else {
      query = `
        SELECT a.*, u_p.name as patient_name, u_d.name as doctor_name,
               (SELECT status FROM payments WHERE appointment_id = a.id LIMIT 1) as payment_status
        FROM appointments a
        JOIN users u_p ON a.patient_id = u_p.id
        JOIN doctors d ON a.doctor_id = d.id
        JOIN users u_d ON d.user_id = u_d.id
        ORDER BY a.date DESC, a.time DESC
      `;
    }

    const params = (role === 'patient' || role === 'doctor') ? [userId] : [];
    const appointments = db.prepare(query).all(...params);
    res.json(appointments);
  });

  // Appointments: Update Status
  app.patch("/api/appointments/:id", (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    try {
      db.prepare("UPDATE appointments SET status = ?, notes = ? WHERE id = ?")
        .run(status, notes || null, id);
      
      // Send Gmail Notification for update
      const app = db.prepare(`
        SELECT a.*, u_d.name as doctor_name, a.patient_id
        FROM appointments a 
        JOIN doctors d ON a.doctor_id = d.id 
        JOIN users u_d ON d.user_id = u_d.id 
        WHERE a.id = ?
      `).get(id);

      if (app && status) {
        sendGmailReminder(app.patient_id, `Appointment ${status.charAt(0).toUpperCase() + status.slice(1)} - BookMyCare`, `
          <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; rounded: 12px;">
            <h2 style="color: ${status === 'approved' ? '#059669' : '#dc2626'};">Appointment ${status.charAt(0).toUpperCase() + status.slice(1)}</h2>
            <p>Your appointment with <strong>Dr. ${app.doctor_name}</strong> has been <strong>${status}</strong>.</p>
            <p><strong>Date:</strong> ${app.date}</p>
            <p><strong>Time:</strong> ${app.time}</p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
            <p style="font-size: 12px; color: #64748b;">This is an automated notification from BookMyCare.</p>
          </div>
        `);
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Admin: Stats
  app.get("/api/admin/stats", (req, res) => {
    const totalPatients = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'patient'").get().count;
    const totalDoctors = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'doctor'").get().count;
    const totalAppointments = db.prepare("SELECT COUNT(*) as count FROM appointments").get().count;
    const revenue = db.prepare("SELECT SUM(amount) as total FROM payments WHERE status = 'completed'").get().total || 0;

    res.json({ totalPatients, totalDoctors, totalAppointments, revenue });
  });

  // Payments: Create
  app.post("/api/payments", (req, res) => {
    const { appointment_id, amount } = req.body;
    const transaction_id = "TXN" + Math.random().toString(36).substr(2, 9).toUpperCase();
    
    try {
      db.prepare("INSERT INTO payments (appointment_id, amount, status, transaction_id) VALUES (?, ?, 'completed', ?)")
        .run(appointment_id, amount, transaction_id);
      res.json({ success: true, transaction_id });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // --- VITE MIDDLEWARE ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
