const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static('uploads'));

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'gateway01.us-west-2.prod.aws.tidbcloud.com',
  user: process.env.DB_USER || '417ZsdFRiJocQ5b.root',
  password: process.env.DB_PASSWORD || 'Xykv3WsBxTnwejdj',
  database: process.env.DB_NAME || 'glaucoma_management_system',
  port: process.env.DB_PORT || 4000,
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test database connection
pool.getConnection()
  .then(connection => {
    console.log('✅ Database connection successful');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
  });

// สร้างตาราง IOP_Measurements ถ้ายังไม่มี
const createIOPMeasurementsTable = async () => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS IOP_Measurements (
        measurement_id VARCHAR(36) PRIMARY KEY,
        patient_id VARCHAR(36) NOT NULL,
        doctor_id VARCHAR(36) NULL,
        measurement_date DATE NOT NULL,
        measurement_time TIME NOT NULL,
        left_eye_iop DECIMAL(4,1) NULL,
        right_eye_iop DECIMAL(4,1) NULL,
        measurement_method VARCHAR(50) DEFAULT 'GAT',
        notes TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_iop_patient (patient_id),
        INDEX idx_iop_doctor (doctor_id),
        INDEX idx_iop_date (measurement_date)
      )
    `);
    console.log('✅ IOP_Measurements table ready');
  } catch (error) {
    console.log('⚠️ IOP_Measurements table issue:', error.message);
  }
};

// เรียกใช้ฟังก์ชัน
setTimeout(() => {
  createIOPMeasurementsTable();
}, 1000);



// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Authentication middleware for Doctors
const authDoctor = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    if (decoded.role !== 'doctor') {
      return res.status(403).json({ error: 'Access denied. Doctor role required.' });
    }

    const [doctors] = await pool.execute(
      `SELECT d.doctor_id, d.first_name, d.last_name, d.license_number, 
              d.department, d.specialty, u.email, u.phone
       FROM DoctorProfiles d
       JOIN Users u ON d.doctor_id = u.user_id
       WHERE d.doctor_id = ? AND u.role = 'doctor' AND u.status = 'active'`,
      [decoded.userId]
    );

    if (doctors.length === 0) {
      return res.status(401).json({ error: 'Invalid token or doctor not found.' });
    }

    req.doctor = doctors[0];
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Doctor API is running',
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Glaucoma Management System - Doctor API',
    version: '1.0.0',
    endpoints: [
      'POST /api/doctors/register',
      'POST /api/doctors/login',
      'GET /api/doctors/profile',
      'PUT /api/doctors/profile',
      'GET /api/patients',
      'GET /api/patients/:patientId',
      'POST /api/patients/:patientId/medications',
      'GET /api/patients/:patientId/medications',
      'PUT /api/medications/:prescriptionId',
      'DELETE /api/medications/:prescriptionId',
      'POST /api/patients/:patientId/iop-measurements',
      'GET /api/patients/:patientId/iop-measurements',
      'POST /api/patients/:patientId/surgeries',
      'GET /api/patients/:patientId/surgeries',
      'POST /api/patients/:patientId/treatment-plans',
      'GET /api/patients/:patientId/treatment-plan',
      'PUT /api/treatment-plans/:planId',
      'POST /api/patients/:patientId/special-tests',
      'GET /api/patients/:patientId/special-tests',
      'GET /api/special-tests/:testId/details',
      'GET /api/patients/:patientId/special-tests/compare',
      'GET /api/appointments/upcoming',
      'GET /api/adherence-alerts',
      'PUT /api/adherence-alerts/:alertId/resolve',
      'GET /api/dashboard/stats',
      'POST /api/patients/:patientId/assign'
    ]
  });
});

// เพิ่มโค้ดนี้ใน backend หลัง Database connection pool

// แก้ไขตาราง GlaucomaTreatmentPlans
const fixTreatmentPlansTable = async () => {
  try {
    // ลองแก้ไขโครงสร้างตารางก่อน
    await pool.execute(`
      ALTER TABLE GlaucomaTreatmentPlans 
      MODIFY COLUMN treatment_approach VARCHAR(255) NOT NULL
    `);
    console.log('✅ GlaucomaTreatmentPlans table structure fixed');
  } catch (error) {
    console.log('⚠️ Treatment plans table fix issue:', error.message);
    
    // ถ้าแก้ไขไม่ได้ ให้ลบและสร้างใหม่
    try {
      await pool.execute('DROP TABLE IF EXISTS GlaucomaTreatmentPlans');
      await pool.execute(`
        CREATE TABLE GlaucomaTreatmentPlans (
          treatment_plan_id VARCHAR(36) PRIMARY KEY,
          patient_id VARCHAR(36) NOT NULL,
          doctor_id VARCHAR(36) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NULL,
          treatment_approach VARCHAR(255) NOT NULL,
          target_iop_left DECIMAL(4,1) NULL,
          target_iop_right DECIMAL(4,1) NULL,
          follow_up_frequency VARCHAR(100) NULL,
          visual_field_test_frequency VARCHAR(100) NULL,
          notes TEXT NULL,
          status ENUM('active', 'completed', 'discontinued') DEFAULT 'active',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_treatment_patient (patient_id),
          INDEX idx_treatment_doctor (doctor_id),
          INDEX idx_treatment_status (status)
        )
      `);
      console.log('✅ GlaucomaTreatmentPlans table recreated with correct structure');
    } catch (recreateError) {
      console.log('❌ Failed to recreate table:', recreateError.message);
    }
  }
};

// เพิ่มหลังฟังก์ชัน fixTreatmentPlansTable
const fixIOPTable = async () => {
  try {
    await pool.execute(`
      ALTER TABLE IOP_Measurements 
      ADD COLUMN IF NOT EXISTS doctor_id VARCHAR(36) NULL
    `);
    console.log('✅ IOP_Measurements table doctor_id column added');
  } catch (error) {
    console.log('⚠️ IOP table fix issue:', error.message);
  }
};

// เรียกใช้ฟังก์ชัน
setTimeout(() => {
  fixTreatmentPlansTable();
}, 1000);

// เรียกใช้ฟังก์ชัน
setTimeout(() => {
  fixIOPTable();
}, 2000);



// Create/Update treatment plan - แก้ไขเพื่อรองรับ table ใหม่
app.post('/api/patients/:patientId/treatment-plans', authDoctor, async (req, res) => {
  console.log('📋 Creating treatment plan...');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    console.log('🔄 Transaction started');

    const patientId = req.params.patientId;
    const doctorId = req.doctor.doctor_id;
    
    const {
      treatmentApproach, targetIOPLeft, targetIOPRight,
      followUpFrequency, visualFieldTestFrequency, notes
    } = req.body;

    console.log('📋 Treatment plan data:', {
      patientId, doctorId, treatmentApproach, targetIOPLeft, targetIOPRight
    });

    // ตรวจสอบว่า patient มีอยู่จริง
    const [patientExists] = await connection.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patientExists.length === 0) {
      await connection.rollback();
      console.log(`❌ Patient not found: ${patientId}`);
      return res.status(404).json({ error: 'Patient not found' });
    }

    console.log('✅ Patient found:', patientExists[0].first_name, patientExists[0].last_name);

    // สร้างหรือค้นหาความสัมพันธ์ doctor-patient อัตโนมัติ
    let [relationship] = await connection.execute(
      `SELECT relationship_id FROM DoctorPatientRelationships
       WHERE doctor_id = ? AND patient_id = ?`,
      [doctorId, patientId]
    );

    if (relationship.length === 0) {
      const relationshipId = uuidv4();
      await connection.execute(
        `INSERT INTO DoctorPatientRelationships 
         (relationship_id, doctor_id, patient_id, start_date, status)
         VALUES (?, ?, ?, CURDATE(), 'active')`,
        [relationshipId, doctorId, patientId]
      );
      console.log(`✅ Created doctor-patient relationship`);
    } else {
      await connection.execute(
        `UPDATE DoctorPatientRelationships 
         SET status = 'active', end_date = NULL 
         WHERE doctor_id = ? AND patient_id = ?`,
        [doctorId, patientId]
      );
      console.log('✅ Updated relationship to active');
    }

    // Mark existing active plans as completed
    console.log('📋 Marking existing plans as completed...');
    await connection.execute(
      `UPDATE GlaucomaTreatmentPlans 
       SET status = 'completed', end_date = CURDATE()
       WHERE patient_id = ? AND status = 'active'`,
      [patientId]
    );

    // Create new treatment plan
    console.log('📋 Creating new treatment plan...');
    const treatmentPlanId = uuidv4();

    await connection.execute(
      `INSERT INTO GlaucomaTreatmentPlans (
        treatment_plan_id, patient_id, doctor_id, start_date, treatment_approach,
        target_iop_left, target_iop_right, follow_up_frequency,
        visual_field_test_frequency, notes, status
      ) VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, 'active')`,
      [
        treatmentPlanId, 
        patientId, 
        doctorId, 
        treatmentApproach || 'Standard glaucoma treatment',
        targetIOPLeft && !isNaN(parseFloat(targetIOPLeft)) ? parseFloat(targetIOPLeft) : null,
        targetIOPRight && !isNaN(parseFloat(targetIOPRight)) ? parseFloat(targetIOPRight) : null,
        followUpFrequency || null,
        visualFieldTestFrequency || null,
        notes || null
      ]
    );

    await connection.commit();
    console.log(`✅ Treatment plan created successfully: ${treatmentPlanId}`);

    res.status(201).json({
      treatmentPlanId,
      message: 'Treatment plan created successfully'
    });
    return;

  } catch (error) {
    try {
      if (connection && !connection.destroyed) {
        await connection.rollback();
      }
    } catch (rollbackError) {
      console.log('⚠️ Rollback issue:', rollbackError.message);
    }
    
    console.error('❌ Error creating treatment plan:', error);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage
    });
    
    let errorMessage = 'Failed to create treatment plan';
    if (error.sqlMessage) {
      errorMessage = 'Database error: ' + error.sqlMessage;
    }

    res.status(500).json({ error: errorMessage });
  } finally {
    try {
      if (connection && !connection.destroyed) {
        connection.release();
      }
    } catch (releaseError) {
      console.log('⚠️ Connection release issue:', releaseError.message);
    }
  }
});

// ===========================================
// DOCTOR AUTHENTICATION ROUTES
// ===========================================

// Doctor Registration
app.post('/api/doctors/register', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      email, password, firstName, lastName, licenseNumber,
      phone, department, specialty, education, hospitalAffiliation
    } = req.body;

    // Validation
    if (!email || !password || !firstName || !lastName || !licenseNumber) {
      await connection.rollback();
      return res.status(400).json({ error: 'Required fields missing' });
    }

    // Check if doctor already exists
    const [existingUser] = await connection.execute(
      'SELECT user_id FROM Users WHERE email = ?',
      [email]
    );

    if (existingUser.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Doctor already registered with this email' });
    }

    // Check license number
    const [existingLicense] = await connection.execute(
      'SELECT doctor_id FROM DoctorProfiles WHERE license_number = ?',
      [licenseNumber]
    );

    if (existingLicense.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'License number already registered' });
    }

    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    await connection.execute(
      `INSERT INTO Users (user_id, role, password_hash, email, phone, 
                         require_password_change, status)
       VALUES (?, 'doctor', ?, ?, ?, 0, 'active')`,
      [userId, hashedPassword, email, phone]
    );

    // Create doctor profile
    await connection.execute(
      `INSERT INTO DoctorProfiles (
        doctor_id, first_name, last_name, license_number, department,
        specialty, education, hospital_affiliation, registration_date, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), 'active')`,
      [userId, firstName, lastName, licenseNumber, department, specialty, education, hospitalAffiliation]
    );

    await connection.commit();

    // Generate JWT token
    const token = jwt.sign(
      { userId: userId, role: 'doctor' },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Doctor registered successfully',
      token,
      doctor: {
        id: userId,
        firstName,
        lastName,
        email,
        licenseNumber,
        department,
        specialty
      }
    });
  } catch (error) {
    await connection.rollback();
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

// Doctor Login
app.post('/api/doctors/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [doctors] = await pool.execute(
      `SELECT u.user_id, u.password_hash, u.status, d.first_name, d.last_name,
              d.license_number, d.department, d.specialty, u.email
       FROM Users u
       JOIN DoctorProfiles d ON u.user_id = d.doctor_id
       WHERE u.email = ? AND u.role = 'doctor'`,
      [email]
    );

    if (doctors.length === 0) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const doctor = doctors[0];

    if (doctor.status !== 'active') {
      return res.status(400).json({ error: 'Account is not active' });
    }

    const isValidPassword = await bcrypt.compare(password, doctor.password_hash);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await pool.execute(
      'UPDATE Users SET last_login = NOW() WHERE user_id = ?',
      [doctor.user_id]
    );

    const token = jwt.sign(
      { userId: doctor.user_id, role: 'doctor' },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      doctor: {
        id: doctor.user_id,
        firstName: doctor.first_name,
        lastName: doctor.last_name,
        email: doctor.email,
        licenseNumber: doctor.license_number,
        department: doctor.department,
        specialty: doctor.specialty
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Doctor Profile
app.get('/api/doctors/profile', authDoctor, async (req, res) => {
  try {
    const [profile] = await pool.execute(
      `SELECT d.*, u.email, u.phone, u.created_at, u.last_login
       FROM DoctorProfiles d
       JOIN Users u ON d.doctor_id = u.user_id
       WHERE d.doctor_id = ?`,
      [req.doctor.doctor_id]
    );

    res.json(profile[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Doctor Profile
app.put('/api/doctors/profile', authDoctor, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      firstName, lastName, department, specialty, education, 
      hospitalAffiliation, phone, bio, consultationHours
    } = req.body;

    // Update doctor profile
    await connection.execute(
      `UPDATE DoctorProfiles SET 
       first_name = ?, last_name = ?, department = ?, specialty = ?,
       education = ?, hospital_affiliation = ?, bio = ?, consultation_hours = ?
       WHERE doctor_id = ?`,
      [firstName, lastName, department, specialty, education, 
       hospitalAffiliation, bio, consultationHours, req.doctor.doctor_id]
    );

    // Update user phone if provided
    if (phone) {
      await connection.execute(
        'UPDATE Users SET phone = ? WHERE user_id = ?',
        [phone, req.doctor.doctor_id]
      );
    }

    await connection.commit();
    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

// ===========================================
// PATIENT MANAGEMENT ROUTES
// ===========================================

// Get all patients under doctor's care
app.get('/api/patients', authDoctor, async (req, res) => {
    try {
        // แสดงผู้ป่วยทั้งหมด แทนที่จะกรองตาม doctor
        const [patients] = await pool.execute(`
            SELECT patient_id, hn, first_name, last_name, date_of_birth, 
                   gender, registration_date
            FROM PatientProfiles 
            ORDER BY registration_date DESC
        `);
        
        res.json(patients);
    } catch (error) {
        console.error('Error getting patients:', error);
        res.status(500).json({ error: error.message });
    }
});


// Get specific patient with complete medical info
app.get('/api/patients/:patientId', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;

    // ลบการตรวจสอบ doctor relationship แล้ว

    // Get patient basic info
    const [patients] = await pool.execute(
      `SELECT p.*, u.email, u.phone,
              TIMESTAMPDIFF(YEAR, p.date_of_birth, CURDATE()) as age
       FROM PatientProfiles p
       JOIN Users u ON p.patient_id = u.user_id
       WHERE p.patient_id = ?`,
      [patientId]
    );

    if (patients.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const patient = patients[0];

    // Get latest IOP measurements
    const [latestIOP] = await pool.execute(
      `SELECT * FROM IOP_Measurements 
       WHERE patient_id = ? 
       ORDER BY measurement_date DESC, measurement_time DESC 
       LIMIT 5`,
      [patientId]
    );

    // Get active medications
    const [medications] = await pool.execute(
      `SELECT pm.*, m.name as medication_name, m.generic_name,
              COALESCE(CONCAT(d.first_name, ' ', d.last_name), 'ไม่ระบุ') as prescribed_by
       FROM PatientMedications pm
       JOIN Medications m ON pm.medication_id = m.medication_id
       LEFT JOIN DoctorProfiles d ON pm.doctor_id = d.doctor_id
       WHERE pm.patient_id = ? AND pm.status = 'active'
       ORDER BY pm.start_date DESC`,
      [patientId]
    );

    // Get medical history
    const [medicalHistory] = await pool.execute(
      `SELECT * FROM PatientMedicalHistory 
       WHERE patient_id = ? 
       ORDER BY recorded_at DESC`,
      [patientId]
    );

    // Get active treatment plan
    const [treatmentPlan] = await pool.execute(
      `SELECT gtp.*, CONCAT(d.first_name, ' ', d.last_name) as created_by
       FROM GlaucomaTreatmentPlans gtp
       LEFT JOIN DoctorProfiles d ON gtp.doctor_id = d.doctor_id
       WHERE gtp.patient_id = ? AND gtp.status = 'active' 
       ORDER BY gtp.start_date DESC 
       LIMIT 1`,
      [patientId]
    );

    res.json({
      ...patient,
      latestIOP,
      medications,
      medicalHistory,
      treatmentPlan: treatmentPlan[0] || null
    });
  } catch (error) {
    console.error('Error getting patient details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Assign patient to doctor
app.post('/api/patients/:patientId/assign', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;

    // Check if patient exists
    const [patient] = await pool.execute(
      'SELECT patient_id FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patient.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // Check if relationship already exists
    const [existing] = await pool.execute(
      `SELECT relationship_id FROM DoctorPatientRelationships
       WHERE doctor_id = ? AND patient_id = ?`,
      [req.doctor.doctor_id, patientId]
    );

    if (existing.length > 0) {
      // Reactivate if inactive
      await pool.execute(
        `UPDATE DoctorPatientRelationships 
         SET status = 'active', end_date = NULL 
         WHERE doctor_id = ? AND patient_id = ?`,
        [req.doctor.doctor_id, patientId]
      );
    } else {
      // Create new relationship
      const relationshipId = uuidv4();
      await pool.execute(
        `INSERT INTO DoctorPatientRelationships 
         (relationship_id, doctor_id, patient_id, start_date, status)
         VALUES (?, ?, ?, CURDATE(), 'active')`,
        [relationshipId, req.doctor.doctor_id, patientId]
      );
    }

    res.json({ message: 'Patient assigned successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// แก้ไขส่วน Medication Management ใน Backend
// เพิ่มหลังบรรทัดที่ 1100 ใน index.js

// ===========================================
// ปรับปรุง MEDICATION MANAGEMENT - ลบฟิลด์เก่า เพิ่มฟิลด์ใหม่
// ===========================================

// อัปเดต Database Schema สำหรับยา
const updateMedicationSchema = async () => {
  try {
    console.log('🔄 Updating medication schema...');
    
    // เพิ่มคอลัมน์ใหม่ในตาราง Medications
    const newMedicationColumns = [
      'ALTER TABLE Medications ADD COLUMN IF NOT EXISTS instructions TEXT DEFAULT NULL',
      'ALTER TABLE Medications ADD COLUMN IF NOT EXISTS storage_instructions VARCHAR(255) DEFAULT NULL'
    ];

    // เพิ่มคอลัมน์ใหม่ในตาราง PatientMedications
    const newPatientMedicationColumns = [
      'ALTER TABLE PatientMedications ADD COLUMN IF NOT EXISTS eye_selection ENUM("left", "right", "both") DEFAULT "both"',
      'ALTER TABLE PatientMedications ADD COLUMN IF NOT EXISTS concentration VARCHAR(100) DEFAULT NULL',
      'ALTER TABLE PatientMedications ADD COLUMN IF NOT EXISTS frequency_type ENUM("hourly", "specific_time", "custom") DEFAULT "hourly"',
      'ALTER TABLE PatientMedications ADD COLUMN IF NOT EXISTS frequency_value VARCHAR(100) DEFAULT NULL',
      'ALTER TABLE PatientMedications ADD COLUMN IF NOT EXISTS instruction_notes TEXT DEFAULT NULL',
      
      // ลบคอลัมน์เก่า (ถ้าไม่ได้ใช้แล้ว)
      'ALTER TABLE PatientMedications DROP COLUMN IF EXISTS quantity_dispensed',
      'ALTER TABLE PatientMedications DROP COLUMN IF EXISTS refills'
    ];

    // Execute medication table updates
    for (const sql of newMedicationColumns) {
      try {
        await pool.execute(sql);
        console.log('✅ Executed:', sql.substring(0, 50) + '...');
      } catch (error) {
        console.log('⚠️ Column might already exist:', error.message);
      }
    }

    // Execute patient medication table updates
    for (const sql of newPatientMedicationColumns) {
      try {
        await pool.execute(sql);
        console.log('✅ Executed:', sql.substring(0, 50) + '...');
      } catch (error) {
        console.log('⚠️ Column operation issue:', error.message);
      }
    }

    console.log('✅ Medication schema updated successfully');
  } catch (error) {
    console.error('❌ Error updating medication schema:', error);
  }
};

// เรียกใช้ฟังก์ชันอัปเดต schema
setTimeout(() => {
  updateMedicationSchema();
}, 3000);

// เพิ่มฟังก์ชันนี้เข้าไปในไฟล์ index.js ของคุณ

const updateExaminationSchema = async () => {
  try {
    console.log('🔄 Updating examination-related schemas...');
    
    // 1. เพิ่มคอลัมน์สำหรับ Cup-to-Disc Ratio และ Disc Hemorrhage ในตาราง IOP_Measurements
    // เพราะเป็นข้อมูลที่มักจะตรวจพร้อมกับ IOP ในการ Follow-up แต่ละครั้ง
    const iopColumns = [
      'ALTER TABLE IOP_Measurements ADD COLUMN IF NOT EXISTS left_cup_disc_ratio DECIMAL(3,2) NULL',
      'ALTER TABLE IOP_Measurements ADD COLUMN IF NOT EXISTS right_cup_disc_ratio DECIMAL(3,2) NULL',
      'ALTER TABLE IOP_Measurements ADD COLUMN IF NOT EXISTS has_left_disc_hemorrhage BOOLEAN DEFAULT FALSE',
      'ALTER TABLE IOP_Measurements ADD COLUMN IF NOT EXISTS has_right_disc_hemorrhage BOOLEAN DEFAULT FALSE',
      'ALTER TABLE IOP_Measurements ADD COLUMN IF NOT EXISTS recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' // เพิ่มคอลัมน์วันที่นำเข้าข้อมูล
    ];

    for (const sql of iopColumns) {
      try {
        await pool.execute(sql);
        console.log(`✅ Executed IOP table update: ${sql.substring(0, 60)}...`);
      } catch (error) {
        console.log(`⚠️ Column in IOP_Measurements might already exist or failed: ${error.message}`);
      }
    }

    // 2. เพิ่มคอลัมน์สำหรับผลข้างเคียง (Side Effects) ในตาราง Medications
    const medColumns = [
        'ALTER TABLE Medications ADD COLUMN IF NOT EXISTS side_effects TEXT DEFAULT NULL'
    ];
    for (const sql of medColumns) {
         try {
            await pool.execute(sql);
            console.log(`✅ Executed Meds table update: ${sql.substring(0, 60)}...`);
         } catch (error) {
            console.log(`⚠️ Column in Medications might already exist or failed: ${error.message}`);
         }
    }

    // 3. ปรับปรุงตาราง SpecialEyeTests เพื่อให้มี created_at เป็น DATETIME
    const specialTestColumns = [
      'ALTER TABLE SpecialEyeTests MODIFY COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
    ];
    for (const sql of specialTestColumns) {
      try {
        await pool.execute(sql);
        console.log(`✅ Executed SpecialEyeTests table update.`);
      } catch (error) {
        console.log(`⚠️ Failed to update SpecialEyeTests: ${error.message}`);
      }
    }


    console.log('✅ Examination schemas updated successfully.');
  } catch (error) {
    console.error('❌ Error updating examination schemas:', error);
  }
};

// เรียกใช้ฟังก์ชันนี้หลังจากเรียกใช้ฟังก์ชันอัปเดต Schema อื่นๆ
setTimeout(() => {
  updateExaminationSchema();
}, 4000); // ตั้งเวลาให้ทำงานหลังจาก schema อื่นๆ ทำงานเสร็จ

// แก้ไข API สำหรับการสั่งยา - แทนที่โค้ดเดิมทั้งหมด
app.post('/api/patients/:patientId/medications', authDoctor, async (req, res) => {
  console.log('💊 Prescription endpoint called');
  console.log('📝 Request body:', JSON.stringify(req.body, null, 2));
  console.log('👨‍⚕️ Doctor:', req.doctor.doctor_id, req.doctor.first_name, req.doctor.last_name);
  
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    console.log('🔄 Database transaction started');

    const patientId = req.params.patientId;
    const doctorId = req.doctor.doctor_id;

    console.log(`💊 Prescribing medication for patient: ${patientId} by doctor: ${doctorId}`);

    // รับข้อมูลจาก request body - รองรับทั้งระบบเก่าและใหม่
    const {
      medicationName, genericName, category, form, strength,
      
      // ระบบใหม่
      eyeSelection, dosageAmount, concentration, 
      frequencyType, frequencyValue, instructionNotes,
      
      // ระบบเก่า (backward compatibility)
      eye, dosage, frequency, specialInstructions,
      
      duration
      
      // ลบ quantityDispensed และ refills ออกแล้ว
    } = req.body;

    console.log('📋 Medication details (hybrid system):', {
      medicationName, strength, 
      newSystem: { eyeSelection, dosageAmount, frequencyType, frequencyValue },
      oldSystem: { eye, dosage, frequency }
    });

    // ตรวจสอบข้อมูลที่จำเป็น
    if (!medicationName || medicationName.trim() === '') {
      await connection.rollback();
      console.log('❌ Missing medication name');
      return res.status(400).json({ error: 'Medication name is required' });
    }

    if (!strength || strength.trim() === '') {
      await connection.rollback();
      console.log('❌ Missing strength');
      return res.status(400).json({ error: 'Medication strength is required' });
    }

    // ใช้ระบบใหม่ถ้ามี ไม่งั้นใช้ระบบเก่า
    const finalEyeSelection = eyeSelection || eye || 'both';
    const finalDosage = dosageAmount || dosage || '1 หยด';
    const finalFrequencyType = frequencyType || 'hourly';
    const finalFrequencyValue = frequencyValue || frequency || 'วันละ 1 ครั้ง';
    const finalInstructions = instructionNotes || specialInstructions || null;

    if (!finalEyeSelection || finalEyeSelection.trim() === '') {
      await connection.rollback();
      console.log('❌ Missing eye selection');
      return res.status(400).json({ error: 'Eye position is required' });
    }

    if (!finalDosage || finalDosage.trim() === '') {
      await connection.rollback();
      console.log('❌ Missing dosage');
      return res.status(400).json({ error: 'Dosage is required' });
    }

    if (!finalFrequencyValue || finalFrequencyValue.trim() === '') {
      await connection.rollback();
      console.log('❌ Missing frequency');
      return res.status(400).json({ error: 'Frequency is required' });
    }

    console.log('✅ Basic validation passed');

    // ตรวจสอบว่า patient มีอยู่จริง
    console.log('🔍 Checking if patient exists...');
    const [patientExists] = await connection.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patientExists.length === 0) {
      await connection.rollback();
      console.log(`❌ Patient not found: ${patientId}`);
      return res.status(404).json({ error: 'Patient not found' });
    }

    console.log('✅ Patient found:', patientExists[0].first_name, patientExists[0].last_name);

    // สร้างหรือค้นหาความสัมพันธ์ doctor-patient อัตโนมัติ
    console.log('🔍 Checking doctor-patient relationship...');
    let [relationship] = await connection.execute(
      `SELECT relationship_id FROM DoctorPatientRelationships
       WHERE doctor_id = ? AND patient_id = ?`,
      [doctorId, patientId]
    );

    if (relationship.length === 0) {
      // สร้างความสัมพันธ์ใหม่
      console.log('🔗 Creating new doctor-patient relationship...');
      const relationshipId = uuidv4();
      await connection.execute(
        `INSERT INTO DoctorPatientRelationships 
         (relationship_id, doctor_id, patient_id, start_date, status)
         VALUES (?, ?, ?, CURDATE(), 'active')`,
        [relationshipId, doctorId, patientId]
      );
      console.log(`✅ Created doctor-patient relationship: ${relationshipId}`);
    } else {
      // อัปเดตสถานะให้ active ถ้าไม่ใช่
      await connection.execute(
        `UPDATE DoctorPatientRelationships 
         SET status = 'active', end_date = NULL 
         WHERE doctor_id = ? AND patient_id = ?`,
        [doctorId, patientId]
      );
      console.log('✅ Updated existing relationship to active');
    }

    // ค้นหาหรือสร้างยา
    console.log('🔍 Checking if medication exists...');
    let [medication] = await connection.execute(
      'SELECT medication_id FROM Medications WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))',
      [medicationName]
    );

    let medicationId;
    if (medication.length === 0) {
        console.log('💊 Creating new medication...');
        medicationId = uuidv4();
  
  // --- [ส่วนที่แก้ไข 1] ---
  // รับข้อมูล 'storageInstructions' และ 'sideEffects' เพิ่มเติมจาก request body
  // ซึ่งเป็นข้อมูลที่มาจากฟอร์มที่แพทย์กรอก
      const { storageInstructions, sideEffects } = req.body;

  // --- [ส่วนที่แก้ไข 2] ---
  // ปรับปรุง Logic การสร้างคำแนะนำการเก็บรักษา:
  // 1. ใช้ค่าที่แพทย์กรอกเข้ามาเป็นหลัก (storageInstructions)
  // 2. ถ้าแพทย์ไม่ได้กรอก, ให้ระบบสร้างอัตโนมัติตามชื่อยา (เป็นค่าสำรอง)
    let finalStorageInstructions = storageInstructions; // ใช้ค่าที่กรอกมาเป็นค่าเริ่มต้น
    if (!finalStorageInstructions) { // ถ้าค่าที่กรอกมาเป็นค่าว่าง
      if (medicationName.toLowerCase().includes('latanoprost') || 
          medicationName.toLowerCase().includes('travoprost')) {
        finalStorageInstructions = 'ควรเก็บในตู้เย็นก่อนเปิดขวด';
      } else if (medicationName.toLowerCase().includes('timolol')) {
        finalStorageInstructions = 'เก็บที่อุณหภูมิห้อง';
      } else if (medicationName.toLowerCase().includes('brimonidine')) {
        finalStorageInstructions = 'เก็บในที่แห้ง หลีกเลี่ยงแสงแดด';
      } else {
        finalStorageInstructions = 'เก็บในที่แห้ง หลีกเลี่ยงแสงแดด';
      }
    }

  // --- [ส่วนที่แก้ไข 3] ---
  // เพิ่มคอลัมน์ "side_effects" เข้าไปในคำสั่ง SQL INSERT
  await connection.execute(
    `INSERT INTO Medications (
      medication_id, name, generic_name, category, form, strength, 
      instructions, storage_instructions, side_effects, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      // --- [ส่วนที่แก้ไข 4] ---
      // เพิ่มค่าสำหรับคอลัมน์ใหม่ลงใน array
      medicationId, 
      medicationName.trim(), 
      genericName ? genericName.trim() : medicationName.trim(), 
      category || 'eye_drops',
      form || 'eye-drops',
      strength.trim(),
      'ใช้ตามแพทย์สั่ง เขย่าก่อนใช้',
      finalStorageInstructions,       // <-- ใช้ค่าที่ปรับปรุงแล้ว
      sideEffects || null             // <-- เพิ่มค่า side_effects เข้ามา
    ]
  );
  console.log(`✅ Created new medication: ${medicationName} (${medicationId})`);
} else {
  medicationId = medication[0].medication_id;
  console.log(`✅ Using existing medication: ${medicationName} (${medicationId})`);
}

    // สร้างใบสั่งยา
    console.log('📋 Creating prescription...');
    const prescriptionId = uuidv4();
    const startDate = new Date().toISOString().split('T')[0];
    let endDate = null;

    // คำนวณวันสิ้นสุด
    if (duration && !isNaN(parseInt(duration)) && parseInt(duration) > 0) {
      const end = new Date();
      end.setDate(end.getDate() + parseInt(duration));
      endDate = end.toISOString().split('T')[0];
      console.log(`📅 End date calculated: ${endDate}`);
    }

    // แปลง values ให้ถูกต้อง
    const durationValue = duration && !isNaN(parseInt(duration)) ? parseInt(duration) : null;
    const instructionsValue = finalInstructions && finalInstructions.trim() ? finalInstructions.trim() : null;

    console.log('💾 Inserting prescription into database...');
    await connection.execute(
      `INSERT INTO PatientMedications (
        prescription_id, patient_id, medication_id, doctor_id, prescribed_date,
        start_date, end_date, eye, dosage, frequency, duration, 
        special_instructions, status,
        eye_selection, concentration, frequency_type, frequency_value, instruction_notes
      ) VALUES (?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        prescriptionId, patientId, medicationId, doctorId,
        startDate, endDate, 
        finalEyeSelection, // eye (รองรับระบบเก่า)
        finalDosage, // dosage (รองรับระบบเก่า)
        finalFrequencyValue, // frequency (รองรับระบบเก่า)
        durationValue, 
        instructionsValue, // special_instructions (รองรับระบบเก่า)
        // ฟิลด์ระบบใหม่
        finalEyeSelection, // eye_selection 
        concentration || null, // concentration
        finalFrequencyType, // frequency_type
        finalFrequencyValue, // frequency_value
        instructionsValue // instruction_notes
      ]
    );

    await connection.commit();
    console.log(`✅ Medication prescribed successfully!`);
    console.log(`📋 Prescription ID: ${prescriptionId}`);
    console.log(`💊 Medication ID: ${medicationId}`);

    // ส่ง response ในรูปแบบที่ frontend คาดหวัง - ใช้รูปแบบเดิม
    res.status(201).json({
      prescriptionId,
      message: 'Medication prescribed successfully'
    });

  } catch (error) {
    await connection.rollback();
    console.error('❌ Error prescribing medication:', error);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage,
      stack: error.stack
    });
    
    // ส่ง error message แบบง่าย ๆ ที่ frontend เดิมรับได้
    let errorMessage = 'Failed to prescribe medication';
    
    if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = 'Medication already prescribed';
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      errorMessage = 'Invalid reference data';
    } else if (error.code === 'ER_DATA_TOO_LONG') {
      errorMessage = 'Data too long';
    } else if (error.code === 'ER_BAD_FIELD_ERROR') {
      errorMessage = 'Database field error';
    } else if (error.sqlMessage) {
      console.log('SQL Error Details:', error.sqlMessage);
      errorMessage = 'Database error: ' + error.sqlMessage;
    } else {
      errorMessage = error.message;
    }

    res.status(500).json({ error: errorMessage });
  } finally {
    console.log('🔚 Releasing database connection');
    connection.release();
  }
});

// แก้ไข API ดึงข้อมูลยา - แทนที่โค้ดเดิมทั้งหมด
app.get('/api/patients/:patientId/medications', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;

    console.log(`🔍 Loading medications for patient: ${patientId}`);

    // ตรวจสอบว่า patient มีอยู่จริง
    const [patientExists] = await pool.execute(
      'SELECT patient_id FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patientExists.length === 0) {
      console.log(`❌ Patient not found: ${patientId}`);
      return res.status(404).json({ error: 'Patient not found' });
    }

    // ลบการตรวจสอบ doctor relationship - แสดงยาทั้งหมด
    // ดึงข้อมูลยาพร้อมฟิลด์ใหม่และเก่า
    const [medications] = await pool.execute(
      `SELECT pm.prescription_id, pm.eye, pm.dosage, pm.frequency, pm.start_date,
              pm.end_date, pm.status, pm.special_instructions, pm.prescribed_date,
              pm.duration, pm.discontinued_reason,
              -- ฟิลด์ใหม่ (ถ้ามี)
              pm.eye_selection, pm.concentration, pm.frequency_type, 
              pm.frequency_value, pm.instruction_notes,
              m.name as medication_name, m.generic_name, m.category, m.form, m.strength,
              -- ฟิลด์ใหม่ในตาราง Medications (ถ้ามี)
              m.instructions as medication_instructions, m.storage_instructions,
              COALESCE(CONCAT(d.first_name, ' ', d.last_name), 'ไม่ระบุ') as prescribed_by
       FROM PatientMedications pm
       JOIN Medications m ON pm.medication_id = m.medication_id
       LEFT JOIN DoctorProfiles d ON pm.doctor_id = d.doctor_id
       WHERE pm.patient_id = ?
       ORDER BY pm.prescribed_date DESC, pm.start_date DESC`,
      [patientId]
    );

    console.log(`✅ Found ${medications.length} medications for patient ${patientId}`);
    
    // ปรับปรุงข้อมูลให้รองรับทั้งระบบเก่าและใหม่ + แสดงฟีเจอร์ใหม่
    const processedMedications = medications.map(med => ({
      // ข้อมูลเดิมที่ frontend คาดหวัง
      prescription_id: med.prescription_id,
      eye: med.eye,
      dosage: med.dosage, 
      frequency: med.frequency,
      start_date: med.start_date,
      end_date: med.end_date,
      status: med.status,
      special_instructions: med.special_instructions,
      prescribed_date: med.prescribed_date,
      duration: med.duration,
      discontinued_reason: med.discontinued_reason,
      medication_name: med.medication_name,
      generic_name: med.generic_name,
      category: med.category,
      form: med.form,
      strength: med.strength,
      prescribed_by: med.prescribed_by,
      
      // ฟีเจอร์ใหม่ - ใช้ฟิลด์ใหม่ถ้ามี ไม่งั้นใช้ฟิลด์เก่า
      eye_selection: med.eye_selection || med.eye || 'both',
      concentration: med.concentration || null,
      frequency_type: med.frequency_type || 'hourly', 
      frequency_value: med.frequency_value || med.frequency || 'วันละ 1 ครั้ง',
      instruction_notes: med.instruction_notes || med.special_instructions || null,
      
      // ฟีเจอร์ใหม่ - คำแนะนำการเก็บรักษา
      medication_instructions: med.medication_instructions || 'ใช้ตามแพทย์สั่ง',
      storage_instructions: med.storage_instructions || 'เก็บในที่แห้ง หลีกเลี่ยงแสงแดด',
      
      // ฟิลด์รวม สำหรับ frontend ใหม่
      final_eye_selection: med.eye_selection || med.eye || 'both',
      final_dosage: med.dosage || '1 หยด',
      final_frequency_type: med.frequency_type || 'hourly',
      final_frequency_value: med.frequency_value || med.frequency || 'วันละ 1 ครั้ง',
      final_instructions: med.instruction_notes || med.special_instructions || null,
      storage_info: med.storage_instructions || 'เก็บในที่แห้ง หลีกเลี่ยงแสงแดด'
    }));
    
    // ส่ง response ในรูปแบบที่ frontend คาดหวัง
    res.json(processedMedications);

  } catch (error) {
    console.error('❌ Error getting patient medications:', error);
    res.status(500).json({ 
      error: 'Internal server error'
    });
  }
});

// เพิ่ม API สำหรับอัปเดตยา (แก้ไขยา)
app.put('/api/medications/:prescriptionId', authDoctor, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    const prescriptionId = req.params.prescriptionId;
    const doctorId = req.doctor.doctor_id;
    const {
      eyeSelection, dosageAmount, concentration, 
      frequencyType, frequencyValue, instructionNotes,
      status, discontinuedReason
    } = req.body;

    console.log(`📝 Updating prescription: ${prescriptionId}`);

    // ตรวจสอบสิทธิ์ในการแก้ไข
    const [prescription] = await connection.execute(
      `SELECT pm.prescription_id, pm.patient_id 
       FROM PatientMedications pm
       WHERE pm.prescription_id = ? AND pm.doctor_id = ?`,
      [prescriptionId, doctorId]
    );

    if (prescription.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Prescription not found or unauthorized' });
    }

    // สร้าง dynamic update query
    const updateFields = [];
    const updateValues = [];

    if (eyeSelection) {
      updateFields.push('eye_selection = ?', 'eye = ?');
      updateValues.push(eyeSelection, eyeSelection);
    }
    if (dosageAmount) {
      updateFields.push('dosage = ?');
      updateValues.push(dosageAmount);
    }
    if (concentration) {
      updateFields.push('concentration = ?');
      updateValues.push(concentration);
    }
    if (frequencyType) {
      updateFields.push('frequency_type = ?');
      updateValues.push(frequencyType);
    }
    if (frequencyValue) {
      updateFields.push('frequency_value = ?', 'frequency = ?');
      updateValues.push(frequencyValue, frequencyValue);
    }
    if (instructionNotes !== undefined) {
      updateFields.push('instruction_notes = ?', 'special_instructions = ?');
      updateValues.push(instructionNotes, instructionNotes);
    }
    if (status) {
      updateFields.push('status = ?');
      updateValues.push(status);
      if (status === 'discontinued' && discontinuedReason) {
        updateFields.push('discontinued_reason = ?');
        updateValues.push(discontinuedReason);
      }
    }

    if (updateFields.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'No fields to update' });
    }

    updateFields.push('updated_at = NOW()');
    updateValues.push(prescriptionId);

    await connection.execute(
      `UPDATE PatientMedications SET ${updateFields.join(', ')} WHERE prescription_id = ?`,
      updateValues
    );

    await connection.commit();
    console.log(`✅ Prescription updated successfully: ${prescriptionId}`);

    res.json({ 
      message: 'Prescription updated successfully',
      prescriptionId 
    });

  } catch (error) {
    await connection.rollback();
    console.error('❌ Error updating prescription:', error);
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

// เพิ่ม API สำหรับลบยา (อัปเดตระบบเก่า)
app.delete('/api/medications/:prescriptionId', authDoctor, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    const prescriptionId = req.params.prescriptionId;
    const doctorId = req.doctor.doctor_id;
    const { reason } = req.body;

    console.log(`🗑️ Discontinuing prescription: ${prescriptionId}`);

    // ตรวจสอบสิทธิ์ในการหยุดยา
    const [prescription] = await connection.execute(
      `SELECT pm.prescription_id, pm.patient_id, pm.status
       FROM PatientMedications pm
       WHERE pm.prescription_id = ? AND pm.doctor_id = ?`,
      [prescriptionId, doctorId]
    );

    if (prescription.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Prescription not found or unauthorized' });
    }

    if (prescription[0].status !== 'active') {
      await connection.rollback();
      return res.status(400).json({ error: 'Prescription is already discontinued' });
    }

    // หยุดยา
    await connection.execute(
      `UPDATE PatientMedications 
       SET status = 'discontinued', 
           discontinued_reason = ?,
           end_date = CURDATE(),
           updated_at = NOW()
       WHERE prescription_id = ?`,
      [reason || 'หยุดโดยแพทย์', prescriptionId]
    );

    await connection.commit();
    console.log(`✅ Prescription discontinued successfully: ${prescriptionId}`);

    res.json({ 
      message: 'Prescription discontinued successfully',
      prescriptionId,
      reason: reason || 'หยุดโดยแพทย์'
    });

  } catch (error) {
    await connection.rollback();
    console.error('❌ Error discontinuing prescription:', error);
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

console.log('✅ Updated Medication Management APIs with new schema');
console.log('🔧 New features implemented:');
console.log('   ✅ Eye selection dropdown (left/right/both)');
console.log('   ✅ Dosage dropdown support (1 หยด default)');
console.log('   ✅ Concentration field');
console.log('   ✅ Frequency type (hourly/specific_time)');
console.log('   ✅ Enhanced instruction notes');
console.log('   ✅ Automatic storage instructions');
console.log('   ✅ Backward compatibility with old system');
console.log('   ❌ Removed: quantity_dispensed and refills');
console.log('🔧 Available APIs:');
console.log('   POST /api/patients/:id/medications - สั่งยาแบบใหม่');
console.log('   GET /api/patients/:id/medications - ดูยาแบบใหม่');  
console.log('   PUT /api/medications/:id - แก้ไขยา');
console.log('   DELETE /api/medications/:id - หยุดยา');

// ===========================================
// SURGERY MANAGEMENT ROUTES
// ===========================================

// Add glaucoma surgery record
// แทนที่ฟังก์ชันเดิมทั้งหมด
app.post('/api/patients/:patientId/surgeries', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const doctorId = req.doctor.doctor_id;

    // ลดทอนข้อมูลที่รับ เหลือแค่ที่จำเป็น
    const {
      surgeryDate, 
      surgeryType, 
      eye // อาจจะยังจำเป็นอยู่ว่าผ่าตัดตาข้างไหน
    } = req.body;

    if (!surgeryDate || !surgeryType) {
        return res.status(400).json({ error: 'Surgery date and type are required.' });
    }

    const surgeryId = uuidv4();

    await pool.execute(
      `INSERT INTO GlaucomaSurgeries (
        surgery_id, patient_id, doctor_id, surgery_date, surgery_type, eye
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [surgeryId, patientId, doctorId, surgeryDate, surgeryType, eye || null]
    );

    res.status(201).json({
      surgeryId,
      message: 'Surgery record created successfully'
    });
  } catch (error) {
    console.error('❌ Error creating surgery record:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/patients/:patientId/surgeries', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;

    // ลบการตรวจสอบ doctor relationship แล้ว

    const [surgeries] = await pool.execute(
      `SELECT gs.surgery_id, gs.surgery_date, gs.surgery_type, gs.eye,
              gs.pre_op_iop_left, gs.pre_op_iop_right, gs.procedure_details,
              gs.complications, gs.outcome, gs.notes, gs.report_url,
              CONCAT(d.first_name, ' ', d.last_name) as surgeon_name
       FROM GlaucomaSurgeries gs
       LEFT JOIN DoctorProfiles d ON gs.doctor_id = d.doctor_id
       WHERE gs.patient_id = ?
       ORDER BY gs.surgery_date DESC`,
      [patientId]
    );

    res.json(surgeries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// TREATMENT PLAN ROUTES
// ===========================================

// Create/Update treatment plan
app.post('/api/patients/:patientId/treatment-plans', authDoctor, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const patientId = req.params.patientId;
    const {
      treatmentApproach, targetIOPLeft, targetIOPRight,
      followUpFrequency, visualFieldTestFrequency, notes
    } = req.body;

    // สร้าง doctor-patient relationship อัตโนมัติ
    let [relationship] = await connection.execute(
      `SELECT relationship_id, status FROM DoctorPatientRelationships
      WHERE doctor_id = ? AND patient_id = ?`,
      [req.doctor.doctor_id, patientId]
    );

    if (relationship.length === 0) {
      const relationshipId = uuidv4();
      await connection.execute(
        `INSERT INTO DoctorPatientRelationships 
        (relationship_id, doctor_id, patient_id, start_date, status)
        VALUES (?, ?, ?, CURDATE(), 'active')`,
        [relationshipId, req.doctor.doctor_id, patientId]
      );
      console.log(`✅ Created new doctor-patient relationship`);
    } else if (relationship[0].status !== 'active') {
      await connection.execute(
        `UPDATE DoctorPatientRelationships 
        SET status = 'active', end_date = NULL 
        WHERE doctor_id = ? AND patient_id = ?`,
        [req.doctor.doctor_id, patientId]
      );
      console.log(`✅ Reactivated existing doctor-patient relationship`);
    }

    // Mark existing active plans as completed
    await connection.execute(
      `UPDATE GlaucomaTreatmentPlans 
       SET status = 'completed', end_date = CURDATE()
       WHERE patient_id = ? AND status = 'active'`,
      [patientId]
    );

    // Create new treatment plan
    const treatmentPlanId = uuidv4();

    await connection.execute(
      `INSERT INTO GlaucomaTreatmentPlans (
        treatment_plan_id, patient_id, doctor_id, start_date, treatment_approach,
        target_iop_left, target_iop_right, follow_up_frequency,
        visual_field_test_frequency, notes, status
      ) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, 'active')`,
      [treatmentPlanId, patientId, req.doctor.doctor_id, treatmentApproach,
       targetIOPLeft, targetIOPRight, followUpFrequency, visualFieldTestFrequency, notes]
    );

    await connection.commit();

    res.status(201).json({
      treatmentPlanId,
      message: 'Treatment plan created successfully'
    });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

// Get treatment plan for patient
app.get('/api/patients/:patientId/treatment-plan', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;

    // ลบการตรวจสอบ doctor relationship แล้ว

    const [plans] = await pool.execute(
      `SELECT gtp.treatment_plan_id, gtp.start_date, gtp.end_date, gtp.treatment_approach,
              gtp.target_iop_left, gtp.target_iop_right, gtp.follow_up_frequency,
              gtp.visual_field_test_frequency, gtp.notes, gtp.status,
              CONCAT(d.first_name, ' ', d.last_name) as created_by_name
       FROM GlaucomaTreatmentPlans gtp
       LEFT JOIN DoctorProfiles d ON gtp.doctor_id = d.doctor_id
       WHERE gtp.patient_id = ?
       ORDER BY gtp.start_date DESC`,
      [patientId]
    );

    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update treatment plan
app.put('/api/treatment-plans/:planId', authDoctor, async (req, res) => {
  try {
    const planId = req.params.planId;
    const {
      treatmentApproach, targetIOPLeft, targetIOPRight,
      followUpFrequency, visualFieldTestFrequency, notes, status
    } = req.body;

    // Verify plan belongs to doctor's patient
    const [plan] = await pool.execute(
      `SELECT gtp.treatment_plan_id FROM GlaucomaTreatmentPlans gtp
       JOIN DoctorPatientRelationships dpr ON gtp.patient_id = dpr.patient_id
       WHERE gtp.treatment_plan_id = ? AND dpr.doctor_id = ? AND dpr.status = 'active'`,
      [planId, req.doctor.doctor_id]
    );

    if (plan.length === 0) {
      return res.status(403).json({ error: 'Treatment plan not found or unauthorized' });
    }

    const updateFields = [];
    const updateValues = [];

    if (treatmentApproach) {
      updateFields.push('treatment_approach = ?');
      updateValues.push(treatmentApproach);
    }
    if (targetIOPLeft !== undefined) {
      updateFields.push('target_iop_left = ?');
      updateValues.push(targetIOPLeft);
    }
    if (targetIOPRight !== undefined) {
      updateFields.push('target_iop_right = ?');
      updateValues.push(targetIOPRight);
    }
    if (followUpFrequency) {
      updateFields.push('follow_up_frequency = ?');
      updateValues.push(followUpFrequency);
    }
    if (visualFieldTestFrequency) {
      updateFields.push('visual_field_test_frequency = ?');
      updateValues.push(visualFieldTestFrequency);
    }
    if (notes) {
      updateFields.push('notes = ?');
      updateValues.push(notes);
    }
    if (status) {
      updateFields.push('status = ?');
      updateValues.push(status);
      if (status === 'completed') {
        updateFields.push('end_date = CURDATE()');
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updateValues.push(planId);

    await pool.execute(
      `UPDATE GlaucomaTreatmentPlans SET ${updateFields.join(', ')}, updated_at = NOW() 
       WHERE treatment_plan_id = ?`,
      updateValues
    );

    res.json({ message: 'Treatment plan updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// SPECIAL TESTS ROUTES (OCT, CTVF)
// ===========================================

// Add special test results with PDF upload
app.post('/api/patients/:patientId/special-tests', authDoctor, upload.single('pdfFile'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const patientId = req.params.patientId;
    const doctorId = req.doctor.doctor_id;
    const { testType, testDate, eye, testDetails, results, notes } = req.body;

    console.log('🔬 Creating special test:', {
      patientId,
      doctorId,
      testType,
      testDate,
      eye
    });

    // ตรวจสอบข้อมูลที่จำเป็น
    if (!testType || !testDate) {
      await connection.rollback();
      return res.status(400).json({ error: 'กรุณากรอก ประเภทการตรวจ และ วันที่ตรวจ' });
    }

    // ตรวจสอบว่า patient มีอยู่จริง
    const [patientExists] = await connection.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patientExists.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'ไม่พบข้อมูลผู้ป่วย' });
    }

    // สร้าง doctor-patient relationship อัตโนมัติ
    let [relationship] = await connection.execute(
      `SELECT relationship_id FROM DoctorPatientRelationships
       WHERE doctor_id = ? AND patient_id = ?`,
      [doctorId, patientId]
    );

    if (relationship.length === 0) {
      const relationshipId = uuidv4();
      await connection.execute(
        `INSERT INTO DoctorPatientRelationships 
         (relationship_id, doctor_id, patient_id, start_date, status)
         VALUES (?, ?, ?, CURDATE(), 'active')`,
        [relationshipId, doctorId, patientId]
      );
      console.log(`✅ Created doctor-patient relationship`);
    }

    const testId = uuidv4();
    const reportUrl = req.file ? req.file.filename : null;

    // บันทึกข้อมูล Special Test
    await connection.execute(
      `INSERT INTO SpecialEyeTests (
        test_id, patient_id, doctor_id, test_date, test_type, eye,
        test_details, results, report_url, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [testId, patientId, doctorId, testDate, testType, eye || 'both',
       testDetails || null, results || null, reportUrl, notes || null]
    );

    // ถ้าเป็น OCT test ให้บันทึกผลเพิ่มเติม
    if (testType === 'OCT' && results) {
      try {
        const resultsData = typeof results === 'string' ? JSON.parse(results) : results;
        const octId = uuidv4();

        await connection.execute(
          `INSERT INTO OCT_Results (
            oct_id, test_id, left_avg_rnfl, right_avg_rnfl, left_superior_rnfl,
            right_superior_rnfl, left_inferior_rnfl, right_inferior_rnfl,
            left_cup_disc_ratio, right_cup_disc_ratio, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [octId, testId, 
           resultsData.leftAvgRNFL || null, resultsData.rightAvgRNFL || null,
           resultsData.leftSuperiorRNFL || null, resultsData.rightSuperiorRNFL || null,
           resultsData.leftInferiorRNFL || null, resultsData.rightInferiorRNFL || null,
           resultsData.leftCupDiscRatio || null, resultsData.rightCupDiscRatio || null]
        );
        console.log(`✅ OCT results saved to OCT_Results table`);
      } catch (parseError) {
        console.warn('Failed to parse OCT results:', parseError);
      }
    }

    await connection.commit();

    console.log(`✅ Special test created successfully: ${testId}`);
    res.status(201).json({
      testId,
      message: 'บันทึกผลการตรวจเรียบร้อยแล้ว',
      test: {
        test_id: testId,
        test_type: testType,
        test_date: testDate,
        patient_name: `${patientExists[0].first_name} ${patientExists[0].last_name}`
      },
      reportUrl: reportUrl ? `/uploads/${reportUrl}` : null
    });

  } catch (error) {
    await connection.rollback();
    console.error('❌ Error creating special test:', error);
    res.status(500).json({ 
      error: 'ไม่สามารถบันทึกผลการตรวจได้: ' + error.message 
    });
  } finally {
    connection.release();
  }
});

console.log('✅ Special tests POST endpoint added successfully');

// Get special tests for patient
app.get('/api/patients/:patientId/special-tests', authDoctor, async (req, res) => {
  console.log('🔬 Special tests API called');
  console.log('🔬 Request params:', req.params);
  console.log('🔬 Request query:', req.query);
  
  try {
    const patientId = req.params.patientId;
    const { testType, startDate, endDate } = req.query;

    console.log('🔬 Variables:', { patientId, testType, startDate, endDate });

    let whereClause = 'WHERE st.patient_id = ?';
    let queryParams = [patientId];

    if (testType && testType !== 'undefined') {
      whereClause += ' AND st.test_type = ?';
      queryParams.push(testType);
    }
    if (startDate && startDate !== 'undefined') {
      whereClause += ' AND st.test_date >= ?';
      queryParams.push(startDate);
    }
    if (endDate && endDate !== 'undefined') {
      whereClause += ' AND st.test_date <= ?';
      queryParams.push(endDate);
    }

    console.log('🔬 Final query params:', queryParams);
    console.log('🔬 WHERE clause:', whereClause);

    const [tests] = await pool.execute(
      `SELECT st.test_id, st.test_date, st.test_type, st.eye,
              st.test_details, st.results, st.report_url, st.notes,
              CONCAT(d.first_name, ' ', d.last_name) as performed_by
       FROM SpecialEyeTests st
       LEFT JOIN DoctorProfiles d ON st.doctor_id = d.doctor_id
       ${whereClause}
       ORDER BY st.test_date DESC`,
      queryParams
    );

    console.log(`✅ Found ${tests.length} special tests`);

    // Format report URLs
    const formattedTests = tests.map(test => ({
      ...test,
      report_url: test.report_url ? `/uploads/${test.report_url}` : null
    }));

    res.json(formattedTests);

  } catch (error) {
    console.error('❌ Special tests error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      queryParams: queryParams || 'undefined'
    });
    res.status(500).json({ error: error.message });
  }
});

// Get detailed special test result
app.get('/api/special-tests/:testId/details', authDoctor, async (req, res) => {
  try {
    const testId = req.params.testId;

    const [testDetails] = await pool.execute(
      `SELECT set.test_id, set.test_date, set.test_type, set.eye,
              set.test_details, set.results, set.report_url, set.notes,
              oct.left_avg_rnfl, oct.right_avg_rnfl, oct.left_superior_rnfl,
              oct.right_superior_rnfl, oct.left_inferior_rnfl, oct.right_inferior_rnfl,
              oct.left_cup_disc_ratio, oct.right_cup_disc_ratio,
              CONCAT(d.first_name, ' ', d.last_name) as performed_by
       FROM SpecialEyeTests set
       LEFT JOIN OCT_Results oct ON set.test_id = oct.test_id
       LEFT JOIN DoctorProfiles d ON set.doctor_id = d.doctor_id
       JOIN DoctorPatientRelationships dpr ON set.patient_id = dpr.patient_id
       WHERE set.test_id = ? AND dpr.doctor_id = ? AND dpr.status = 'active'`,
      [testId, req.doctor.doctor_id]
    );

    if (testDetails.length === 0) {
      return res.status(404).json({ error: 'Special test not found or not accessible' });
    }

    const test = testDetails[0];
    test.report_url = test.report_url ? `/uploads/${test.report_url}` : null;

    res.json(test);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Compare special test results
app.get('/api/patients/:patientId/special-tests/compare', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const { testType, fromDate, toDate } = req.query;

    if (!testType || !fromDate || !toDate) {
      return res.status(400).json({ error: 'testType, fromDate, and toDate are required' });
    }

    // Verify patient access
    const [relationship] = await pool.execute(
      `SELECT relationship_id FROM DoctorPatientRelationships
       WHERE doctor_id = ? AND patient_id = ? AND status = 'active'`,
      [req.doctor.doctor_id, patientId]
    );

    if (relationship.length === 0) {
      return res.status(403).json({ error: 'Patient not under your care' });
    }

    const [tests] = await pool.execute(
      `SELECT set.test_id, set.test_date, set.test_type, set.results,
              oct.left_avg_rnfl, oct.right_avg_rnfl, oct.left_superior_rnfl,
              oct.right_superior_rnfl, oct.left_inferior_rnfl, oct.right_inferior_rnfl,
              oct.left_cup_disc_ratio, oct.right_cup_disc_ratio
       FROM SpecialEyeTests set
       LEFT JOIN OCT_Results oct ON set.test_id = oct.test_id
       WHERE set.patient_id = ? AND set.test_type = ? 
         AND set.test_date BETWEEN ? AND ?
       ORDER BY set.test_date ASC`,
      [patientId, testType, fromDate, toDate]
    );

    // Calculate progression/improvement
    const comparison = tests.map((test, index) => {
      if (index === 0) return { ...test, change: null };

      const prevTest = tests[index - 1];
      const change = {};

      // Calculate changes for OCT RNFL values
      if (test.left_avg_rnfl !== null && prevTest.left_avg_rnfl !== null) {
        change.leftAvgRNFL = test.left_avg_rnfl - prevTest.left_avg_rnfl;
      }
      if (test.right_avg_rnfl !== null && prevTest.right_avg_rnfl !== null) {
        change.rightAvgRNFL = test.right_avg_rnfl - prevTest.right_avg_rnfl;
      }
      if (test.left_superior_rnfl !== null && prevTest.left_superior_rnfl !== null) {
        change.leftSuperiorRNFL = test.left_superior_rnfl - prevTest.left_superior_rnfl;
      }
      if (test.right_superior_rnfl !== null && prevTest.right_superior_rnfl !== null) {
        change.rightSuperiorRNFL = test.right_superior_rnfl - prevTest.right_superior_rnfl;
      }
      if (test.left_inferior_rnfl !== null && prevTest.left_inferior_rnfl !== null) {
        change.leftInferiorRNFL = test.left_inferior_rnfl - prevTest.left_inferior_rnfl;
      }
      if (test.right_inferior_rnfl !== null && prevTest.right_inferior_rnfl !== null) {
        change.rightInferiorRNFL = test.right_inferior_rnfl - prevTest.right_inferior_rnfl;
      }
      // Cup-to-Disc Ratio changes
      if (test.left_cup_disc_ratio !== null && prevTest.left_cup_disc_ratio !== null) {
        change.leftCupDiscRatio = test.left_cup_disc_ratio - prevTest.left_cup_disc_ratio;
      }
      if (test.right_cup_disc_ratio !== null && prevTest.right_cup_disc_ratio !== null) {
        change.rightCupDiscRatio = test.right_cup_disc_ratio - prevTest.right_cup_disc_ratio;
      }

      return { ...test, change };
    });

    res.json(comparison);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// APPOINTMENT MANAGEMENT
// ===========================================

// Get upcoming appointments for the doctor
app.get('/api/appointments/upcoming', authDoctor, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        
        const [appointments] = await pool.execute(`
            SELECT a.appointment_id, a.appointment_date, a.appointment_time,
                   a.appointment_type, p.first_name, p.last_name, p.hn
            FROM Appointments a
            JOIN PatientProfiles p ON a.patient_id = p.patient_id
            WHERE a.appointment_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
            AND a.appointment_status = 'scheduled'
            ORDER BY a.appointment_date ASC, a.appointment_time ASC
        `, [days]);
        
        res.json(appointments);
    } catch (error) {
        console.error('Error getting appointments:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===========================================
// MEDICATION ADHERENCE AND ALERTS
// ===========================================

// Get adherence alerts for the doctor
app.get('/api/adherence-alerts', authDoctor, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const limit = parseInt(req.query.limit) || 10;
        
        const [alerts] = await pool.execute(`
            SELECT a.alert_id, a.created_at as alert_date, a.alert_message as message, 
                   a.resolution_status as status, a.alert_type, a.severity,
                   CONCAT(p.first_name, ' ', p.last_name) as patient_name,
                   p.hn
            FROM Alerts a
            JOIN PatientProfiles p ON a.patient_id = p.patient_id
            WHERE a.resolution_status = ?
            ORDER BY a.created_at DESC
            LIMIT ${limit}
        `, [status]);
        
        res.json(alerts);
    } catch (error) {
        console.error('Error getting alerts:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===========================================
// DASHBOARD AND ANALYTICS
// ===========================================

// Get dashboard statistics
app.get('/api/dashboard/stats', authDoctor, async (req, res) => {
  try {
    const doctorId = req.doctor.doctor_id;
    console.log(`📊 Loading dashboard stats for doctor: ${doctorId}`);

    const stats = {
      totalPatients: 0,
      todayAppointments: 0,
      pendingAlerts: 0,
      needFollowUp: 0,
      highIOPCount: 0,
      activeMedications: 0,
      recentTests: { total_tests: 0, oct_tests: 0, ctvf_tests: 0 }
    };

    // 1. นับผู้ป่วยทั้งหมดในระบบ (แก้ไข: ไม่กรองตาม doctor)
    try {
      const [totalPatients] = await pool.execute(
        `SELECT COUNT(*) as total FROM PatientProfiles`
      );
      stats.totalPatients = totalPatients[0]?.total || 0;
    } catch (error) {
      console.error('Error getting total patients:', error);
    }

    // 2. นัดหมายที่กำลังมาถึง 7 วันข้างหน้า (แก้ไข: ไม่กรองตาม doctor)
    try {
      const [todayAppointments] = await pool.execute(
        `SELECT COUNT(*) as total FROM Appointments 
         WHERE appointment_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
         AND appointment_status IN ('scheduled', 'rescheduled')`
      );
      stats.todayAppointments = todayAppointments[0]?.total || 0;
    } catch (error) {
      console.error('Error getting upcoming appointments:', error);
    }

    // 3. การแจ้งเตือนที่ยังไม่ได้แก้ไข (แก้ไข: ไม่กรองตาม doctor)
    try {
      const [pendingAlerts] = await pool.execute(
        `SELECT COUNT(*) as total FROM Alerts 
         WHERE resolution_status = 'pending'`
      );
      stats.pendingAlerts = pendingAlerts[0]?.total || 0;
    } catch (error) {
      console.error('Error getting pending alerts:', error);
    }

    // 4. ผู้ป่วยที่ต้องติดตาม (แก้ไข: ไม่กรองตาม doctor)
    try {
      const [needFollowUp] = await pool.execute(
        `SELECT COUNT(DISTINCT p.patient_id) as total
         FROM PatientProfiles p
         LEFT JOIN PatientVisits pv ON p.patient_id = pv.patient_id 
           AND pv.visit_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
         WHERE pv.visit_id IS NULL`
      );
      stats.needFollowUp = needFollowUp[0]?.total || 0;
    } catch (error) {
      console.error('Error getting follow-up needed:', error);
      // ถ้าไม่มีตาราง PatientVisits ให้ใช้ค่า 0
      stats.needFollowUp = 0;
    }

    // 5. IOP สูงในเดือนที่แล้ว (แก้ไข: ไม่กรองตาม doctor)
    try {
      const [highIOPCount] = await pool.execute(
        `SELECT COUNT(*) as total FROM IOP_Measurements 
         WHERE measurement_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
           AND (left_eye_iop > 21 OR right_eye_iop > 21)`
      );
      stats.highIOPCount = highIOPCount[0]?.total || 0;
    } catch (error) {
      console.error('Error getting high IOP count:', error);
    }

    // 6. ยาที่กำลังใช้อยู่ (แก้ไข: ไม่กรองตาม doctor)
    try {
      const [activeMedications] = await pool.execute(
        `SELECT COUNT(*) as total FROM PatientMedications 
         WHERE status = 'active'`
      );
      stats.activeMedications = activeMedications[0]?.total || 0;
    } catch (error) {
      console.error('Error getting active medications:', error);
    }

    // 7. การตรวจพิเศษเดือนที่แล้ว (แก้ไข: ไม่กรองตาม doctor และแก้ alias)
    try {
      const [recentTests] = await pool.execute(`
            SELECT 
                COUNT(*) as total_tests,
                SUM(CASE WHEN test_type = 'OCT' THEN 1 ELSE 0 END) as oct_tests,
                SUM(CASE WHEN test_type = 'CTVF' THEN 1 ELSE 0 END) as ctvf_tests
            FROM SpecialEyeTests st
            WHERE st.test_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `);

      stats.recentTests = recentTests[0] || { total_tests: 0, oct_tests: 0, ctvf_tests: 0 };
    } catch (error) {
      console.error('Error getting recent tests:', error);
    }

    console.log(`📈 Dashboard stats loaded:`, stats);
    res.json(stats);

  } catch (error) {
    console.error('Error getting dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// ADHERENCE MONITORING SYSTEM
// ===========================================

// Create AdherenceAlerts table if not exists
const createAdherenceAlertsTable = async () => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS AdherenceAlerts (
        alert_id VARCHAR(36) PRIMARY KEY,
        patient_id VARCHAR(36) NOT NULL,
        doctor_id VARCHAR(36) NOT NULL,
        prescription_id VARCHAR(36) NOT NULL,
        alert_date DATE NOT NULL,
        alert_type ENUM('missed_dose', 'late_dose', 'skipped_dose') NOT NULL,
        message TEXT NOT NULL,
        status ENUM('pending', 'resolved', 'ignored') DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME NULL,
        resolution_notes TEXT NULL,
        INDEX idx_alert_patient (patient_id),
        INDEX idx_alert_doctor (doctor_id),
        INDEX idx_alert_status (status),
        FOREIGN KEY (patient_id) REFERENCES PatientProfiles(patient_id) ON DELETE CASCADE,
        FOREIGN KEY (doctor_id) REFERENCES DoctorProfiles(doctor_id),
        FOREIGN KEY (prescription_id) REFERENCES PatientMedications(prescription_id) ON DELETE CASCADE
      )
    `);
  } catch (error) {
    console.log('AdherenceAlerts table already exists or creation failed:', error.message);
  }
};

// Create PatientDailyAdherence table if not exists
const createPatientDailyAdherenceTable = async () => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS PatientDailyAdherence (
        adherence_id VARCHAR(36) PRIMARY KEY,
        patient_id VARCHAR(36) NOT NULL,
        prescription_id VARCHAR(36) NOT NULL,
        adherence_date DATE NOT NULL,
        taken_status ENUM('taken', 'skipped', 'late') NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        notes TEXT NULL,
        INDEX idx_adherence_patient (patient_id),
        INDEX idx_adherence_prescription (prescription_id),
        INDEX idx_adherence_date (adherence_date),
        FOREIGN KEY (patient_id) REFERENCES PatientProfiles(patient_id) ON DELETE CASCADE,
        FOREIGN KEY (prescription_id) REFERENCES PatientMedications(prescription_id) ON DELETE CASCADE
      )
    `);
  } catch (error) {
    console.log('PatientDailyAdherence table already exists or creation failed:', error.message);
  }
};

// Initialize tables
createAdherenceAlertsTable();
createPatientDailyAdherenceTable();

// Manual adherence recording endpoint (for testing or manual entry)
app.post('/api/patients/:patientId/adherence', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const { prescriptionId, adherenceDate, takenStatus, notes } = req.body;

    // Verify patient access
    const [relationship] = await pool.execute(
      `SELECT relationship_id FROM DoctorPatientRelationships
       WHERE doctor_id = ? AND patient_id = ? AND status = 'active'`,
      [req.doctor.doctor_id, patientId]
    );

    if (relationship.length === 0) {
      return res.status(403).json({ error: 'Patient not under your care' });
    }

    const adherenceId = uuidv4();

    await pool.execute(
      `INSERT INTO PatientDailyAdherence (
        adherence_id, patient_id, prescription_id, adherence_date, taken_status, notes
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [adherenceId, patientId, prescriptionId, adherenceDate, takenStatus, notes]
    );

    res.status(201).json({ message: 'Adherence recorded successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get adherence report for patient
app.get('/api/patients/:patientId/adherence', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const { startDate, endDate, prescriptionId } = req.query;

    // Verify patient access
    const [relationship] = await pool.execute(
      `SELECT relationship_id FROM DoctorPatientRelationships
       WHERE doctor_id = ? AND patient_id = ? AND status = 'active'`,
      [req.doctor.doctor_id, patientId]
    );

    if (relationship.length === 0) {
      return res.status(403).json({ error: 'Patient not under your care' });
    }

    let whereClause = 'WHERE pda.patient_id = ?';
    let queryParams = [patientId];

    if (startDate) {
      whereClause += ' AND pda.adherence_date >= ?';
      queryParams.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND pda.adherence_date <= ?';
      queryParams.push(endDate);
    }
    if (prescriptionId) {
      whereClause += ' AND pda.prescription_id = ?';
      queryParams.push(prescriptionId);
    }

    const [adherenceRecords] = await pool.execute(
      `SELECT pda.*, m.name as medication_name, pm.frequency
       FROM PatientDailyAdherence pda
       JOIN PatientMedications pm ON pda.prescription_id = pm.prescription_id
       JOIN Medications m ON pm.medication_id = m.medication_id
       ${whereClause}
       ORDER BY pda.adherence_date DESC`,
      queryParams
    );

    // Calculate adherence statistics
    const [stats] = await pool.execute(
      `SELECT 
         COUNT(*) as total_records,
         SUM(CASE WHEN taken_status = 'taken' THEN 1 ELSE 0 END) as taken_count,
         SUM(CASE WHEN taken_status = 'skipped' THEN 1 ELSE 0 END) as skipped_count,
         SUM(CASE WHEN taken_status = 'late' THEN 1 ELSE 0 END) as late_count
       FROM PatientDailyAdherence pda
       ${whereClause}`,
      queryParams
    );

    const statistics = stats[0];
    if (statistics.total_records > 0) {
      statistics.adherence_rate = ((statistics.taken_count + statistics.late_count) / statistics.total_records * 100).toFixed(2);
      statistics.perfect_adherence_rate = (statistics.taken_count / statistics.total_records * 100).toFixed(2);
    }

    res.json({
      adherenceRecords,
      statistics
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// EMAIL NOTIFICATION SYSTEM
// ===========================================

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.ethereal.email',
  port: process.env.EMAIL_PORT || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER || 'your_email@example.com',
    pass: process.env.EMAIL_PASS || 'your_email_password'
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Send adherence alert email
const sendAdherenceAlertEmail = async (doctorEmail, patientName, medicationName) => {
  const mailOptions = {
    from: process.env.EMAIL_USER || '"Glaucoma System" <no-reply@example.com>',
    to: doctorEmail,
    subject: `⚠️ แจ้งเตือน: ผู้ป่วย ${patientName} ไม่ได้ใช้ยา ${medicationName} ตามกำหนด`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #d32f2f;">🔔 แจ้งเตือนการใช้ยา</h2>
        <p>เรียนคุณหมอ,</p>
        <div style="background-color: #fff3e0; padding: 15px; border-left: 4px solid #ff9800; margin: 15px 0;">
          <p><strong>ผู้ป่วย:</strong> ${patientName}</p>
          <p><strong>ยา:</strong> ${medicationName}</p>
          <p><strong>สถานะ:</strong> ไม่ได้ใช้ยาตามกำหนด</p>
          <p><strong>วันที่:</strong> ${new Date().toLocaleDateString('th-TH')}</p>
        </div>
        <p>กรุณาตรวจสอบข้อมูลการใช้ยาของผู้ป่วยและพิจารณาให้คำแนะนำเพิ่มเติม</p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
        <p style="font-size: 12px; color: #666;">
          ขอบคุณครับ/ค่ะ<br>
          ทีมงาน Glaucoma Management System
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Adherence alert email sent to ${doctorEmail} for patient ${patientName}`);
  } catch (error) {
    console.error('❌ Error sending adherence alert email:', error);
  }
};

// Send appointment reminder email
const sendAppointmentReminderEmail = async (doctorEmail, patientName, appointmentDate, appointmentTime) => {
  const mailOptions = {
    from: process.env.EMAIL_USER || '"Glaucoma System" <no-reply@example.com>',
    to: doctorEmail,
    subject: `📅 แจ้งเตือนนัดหมาย: ${patientName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1976d2;">📅 แจ้งเตือนนัดหมายผู้ป่วย</h2>
        <p>เรียนคุณหมอ,</p>
        <div style="background-color: #e3f2fd; padding: 15px; border-left: 4px solid #2196f3; margin: 15px 0;">
          <p><strong>ผู้ป่วย:</strong> ${patientName}</p>
          <p><strong>วันที่นัด:</strong> ${appointmentDate}</p>
          <p><strong>เวลา:</strong> ${appointmentTime}</p>
        </div>
        <p>นี่คือการแจ้งเตือนนัดหมายผู้ป่วยของท่านในวันพรุ่งนี้</p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
        <p style="font-size: 12px; color: #666;">
          ขอบคุณครับ/ค่ะ<br>
          ทีมงาน Glaucoma Management System
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Appointment reminder sent to ${doctorEmail} for patient ${patientName}`);
  } catch (error) {
    console.error('❌ Error sending appointment reminder:', error);
  }
};

// ===========================================
// CRON JOBS FOR AUTOMATED MONITORING
// ===========================================

// Daily medication adherence check (runs at 3:00 AM)
cron.schedule('0 3 * * *', async () => {
  console.log('🔄 Running daily medication adherence check...');
  const connection = await pool.getConnection();
  try {
    // Get all active prescriptions
    const [prescriptions] = await connection.execute(
      `SELECT pm.prescription_id, pm.patient_id, pm.doctor_id, pm.frequency,
              m.name as medication_name, 
              CONCAT(p.first_name, ' ', p.last_name) as patient_name,
              u.email as doctor_email
       FROM PatientMedications pm
       JOIN Medications m ON pm.medication_id = m.medication_id
       JOIN PatientProfiles p ON pm.patient_id = p.patient_id
       JOIN DoctorProfiles d ON pm.doctor_id = d.doctor_id
       JOIN Users u ON d.doctor_id = u.user_id
       WHERE pm.status = 'active' 
         AND pm.start_date <= CURDATE() 
         AND (pm.end_date IS NULL OR pm.end_date >= CURDATE())`
    );

    const today = new Date().toISOString().split('T')[0];

    for (const prescription of prescriptions) {
      // Check if there's adherence record for today
      const [adherenceRecords] = await connection.execute(
        `SELECT adherence_id FROM PatientDailyAdherence
         WHERE patient_id = ? AND prescription_id = ? AND adherence_date = ? 
         AND taken_status = 'taken'`,
        [prescription.patient_id, prescription.prescription_id, today]
      );

      // If no 'taken' record for today, consider it missed
      if (adherenceRecords.length === 0) {
        // Check if alert already exists
        const [existingAlert] = await connection.execute(
          `SELECT alert_id FROM AdherenceAlerts
           WHERE patient_id = ? AND prescription_id = ? AND alert_date = ? 
           AND alert_type = 'missed_dose' AND status = 'pending'`,
          [prescription.patient_id, prescription.prescription_id, today]
        );

        if (existingAlert.length === 0) {
          // Create new alert
          const alertId = uuidv4();
          const alertMessage = `ผู้ป่วย ${prescription.patient_name} ไม่ได้ใช้ยา ${prescription.medication_name} ตามกำหนดในวันที่ ${today}`;
          
          await connection.execute(
            `INSERT INTO AdherenceAlerts (
              alert_id, patient_id, doctor_id, prescription_id, alert_date, 
              alert_type, message, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
            [alertId, prescription.patient_id, prescription.doctor_id, 
             prescription.prescription_id, today, 'missed_dose', alertMessage]
          );

          // Send email notification if configured
          if (process.env.EMAIL_USER && process.env.EMAIL_PASS && prescription.doctor_email) {
            await sendAdherenceAlertEmail(
              prescription.doctor_email,
              prescription.patient_name,
              prescription.medication_name
            );
          }

          console.log(`⚠️ Adherence alert created for patient ${prescription.patient_name}, medication ${prescription.medication_name}`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error during daily medication adherence check:', error);
  } finally {
    connection.release();
  }
});

// Daily appointment reminder (runs at 8:00 AM)
cron.schedule('0 8 * * *', async () => {
  console.log('🔄 Running daily appointment reminder check...');
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const [appointments] = await pool.execute(
      `SELECT a.appointment_id, a.appointment_time,
              CONCAT(p.first_name, ' ', p.last_name) as patient_name,
              u.email as doctor_email
       FROM Appointments a
       JOIN PatientProfiles p ON a.patient_id = p.patient_id
       JOIN Users u ON a.doctor_id = u.user_id
       WHERE a.appointment_date = ? 
         AND a.appointment_status IN ('scheduled', 'rescheduled')`,
      [tomorrowStr]
    );

    for (const appointment of appointments) {
      if (appointment.doctor_email) {
        await sendAppointmentReminderEmail(
          appointment.doctor_email,
          appointment.patient_name,
          tomorrow.toLocaleDateString('th-TH'),
          appointment.appointment_time
        );
      }
    }

    console.log(`📅 Sent ${appointments.length} appointment reminders`);
  } catch (error) {
    console.error('❌ Error sending appointment reminders:', error);
  }
});

// ===========================================
// แก้ไข ALERT RESOLVE API
// ===========================================

app.put('/api/adherence-alerts/:alertId/resolve', authDoctor, async (req, res) => {
  try {
    const alertId = req.params.alertId;
    const { resolutionNotes } = req.body;
    const doctorId = req.doctor.doctor_id;

    console.log(`🔧 Resolving alert ${alertId} by doctor ${doctorId}`);

    // ตรวจสอบว่า alert นี้เป็นของผู้ป่วยที่อยู่ภายใต้การดูแลของหมอคนนี้
    const [alert] = await pool.execute(
      `SELECT a.alert_id FROM Alerts a
       JOIN DoctorPatientRelationships dpr ON a.patient_id = dpr.patient_id
       WHERE a.alert_id = ? AND dpr.doctor_id = ? AND dpr.status = 'active'`,
      [alertId, doctorId]
    );

    if (alert.length === 0) {
      return res.status(404).json({ error: 'Alert not found or not authorized to resolve' });
    }

    // อัปเดตสถานะของ alert
    await pool.execute(
      `UPDATE Alerts 
       SET resolution_status = 'resolved', 
           acknowledged = 1,
           acknowledged_by = ?,
           acknowledged_at = NOW(),
           resolution_notes = ?,
           resolved_at = NOW()
       WHERE alert_id = ?`,
      [doctorId, resolutionNotes || 'แก้ไขจาก Dashboard', alertId]
    );

    console.log(`✅ Alert ${alertId} resolved successfully`);
    res.json({ message: 'Alert resolved successfully' });

  } catch (error) {
    console.error('❌ Error resolving alert:', error);
    res.status(500).json({ error: 'ไม่สามารถแก้ไขการแจ้งเตือนได้: ' + error.message });
  }
});

// ===========================================
// เพิ่ม DEBUG ENDPOINTS
// ===========================================

// ตรวจสอบตารางที่มีในฐานข้อมูล
app.get('/api/debug/tables', authDoctor, async (req, res) => {
  try {
    const [tables] = await pool.execute(
      `SELECT TABLE_NAME 
       FROM INFORMATION_SCHEMA.TABLES 
       WHERE TABLE_SCHEMA = DATABASE() 
       ORDER BY TABLE_NAME`
    );
    
    const tableList = tables.map(t => t.TABLE_NAME);
    res.json({ 
      status: 'success',
      database: process.env.DB_NAME || 'glaucoma_management_system',
      tables: tableList,
      count: tableList.length
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// ตรวจสอบข้อมูลพื้นฐาน
app.get('/api/debug/data-summary', authDoctor, async (req, res) => {
  try {
    const doctorId = req.doctor.doctor_id;
    const summary = {};

    // นับข้อมูลในแต่ละตาราง
    const tables = [
      'PatientProfiles',
      'DoctorProfiles', 
      'DoctorPatientRelationships',
      'Appointments',
      'Alerts',
      'IOP_Measurements',
      'PatientMedications',
      'SpecialEyeTests'
    ];

    for (const table of tables) {
      try {
        const [count] = await pool.execute(`SELECT COUNT(*) as total FROM ${table}`);
        summary[table] = count[0].total;
      } catch (error) {
        summary[table] = `Error: ${error.message}`;
      }
    }

    // ข้อมูลเฉพาะของหมอคนนี้
    try {
      const [doctorPatients] = await pool.execute(
        `SELECT COUNT(*) as total FROM DoctorPatientRelationships 
         WHERE doctor_id = ? AND status = 'active'`,
        [doctorId]
      );
      summary.doctorPatients = doctorPatients[0].total;
    } catch (error) {
      summary.doctorPatients = `Error: ${error.message}`;
    }

    res.json({
      status: 'success',
      doctor_id: doctorId,
      summary
    });

  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// ทดสอบการเชื่อมต่อ
app.get('/api/test-connection', authDoctor, async (req, res) => {
  try {
    const [result] = await pool.execute('SELECT NOW() as current_time, DATABASE() as database_name');
    res.json({ 
      status: 'success', 
      message: 'Database connection OK',
      server_time: result[0].current_time,
      database: result[0].database_name,
      doctor: {
        id: req.doctor.doctor_id,
        name: `${req.doctor.first_name} ${req.doctor.last_name}`
      }
    });
  } catch (error) {
    console.error('Test connection error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

console.log('✅ Dashboard APIs updated to use existing tables');
console.log('🔧 Available debug endpoints:');
console.log('   GET /api/test-connection');
console.log('   GET /api/debug/tables');
console.log('   GET /api/debug/data-summary');

// ===========================================
// IOP MEASUREMENT ROUTES
// ===========================================

// แทนที่ฟังก์ชันเดิมทั้งหมด
app.post('/api/patients/:patientId/iop-measurements', authDoctor, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const patientId = req.params.patientId;
    const doctorId = req.doctor.doctor_id;

    // รับข้อมูลใหม่เพิ่มเข้ามา
    const {
      measurementDate,
      measurementTime, 
      leftEyeIOP,
      rightEyeIOP,
      measurementMethod,
      notes,
      leftCupDiscRatio,   // <-- ใหม่
      rightCupDiscRatio,  // <-- ใหม่
      hasLeftDiscHemorrhage, // <-- ใหม่
      hasRightDiscHemorrhage // <-- ใหม่
    } = req.body;

    console.log('📊 Recording Examination Data:', req.body);

    if (!measurementDate || (!leftEyeIOP && !rightEyeIOP && !leftCupDiscRatio && !rightCupDiscRatio)) {
      await connection.rollback();
      return res.status(400).json({ error: 'At least one measurement value (IOP or C/D Ratio) and date are required' });
    }

    const measurementId = uuidv4();
    const formattedTime = measurementTime || new Date().toTimeString().slice(0, 8);

    await connection.execute(
      `INSERT INTO IOP_Measurements (
        measurement_id, patient_id, doctor_id, measurement_date, measurement_time,
        left_eye_iop, right_eye_iop, measurement_method, notes,
        left_cup_disc_ratio, right_cup_disc_ratio,
        has_left_disc_hemorrhage, has_right_disc_hemorrhage,
        recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        measurementId,
        patientId,
        doctorId,
        measurementDate,
        formattedTime,
        leftEyeIOP ? parseFloat(leftEyeIOP) : null,
        rightEyeIOP ? parseFloat(rightEyeIOP) : null,
        measurementMethod || 'GAT',
        notes || null,
        leftCupDiscRatio ? parseFloat(leftCupDiscRatio) : null,
        rightCupDiscRatio ? parseFloat(rightCupDiscRatio) : null,
        !!hasLeftDiscHemorrhage, // แปลงเป็น boolean
        !!hasRightDiscHemorrhage // แปลงเป็น boolean
      ]
    );

    await connection.commit();

    res.status(201).json({
      measurementId,
      message: 'Examination data recorded successfully'
    });

  } catch (error) {
    await connection.rollback();
    console.error('❌ Error recording examination data:', error);
    res.status(500).json({ 
      error: 'Failed to record examination data: ' + error.message 
    });
  } finally {
    connection.release();
  }
});

// Get IOP measurements for patient
app.get('/api/patients/:patientId/iop-measurements', authDoctor, async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const { startDate, endDate, limit } = req.query;

    console.log(`📊 Loading IOP measurements for patient: ${patientId}`);

    // ตรวจสอบว่า patient มีอยู่จริง
    const [patientExists] = await pool.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patientId]
    );

    if (patientExists.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // สร้าง query parameters
    let whereClause = 'WHERE iop.patient_id = ?';
    let queryParams = [patientId];

    if (startDate) {
      whereClause += ' AND iop.measurement_date >= ?';
      queryParams.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND iop.measurement_date <= ?';
      queryParams.push(endDate);
    }

    const limitClause = limit ? `LIMIT ${parseInt(limit)}` : 'LIMIT 50';

    // ดึงข้อมูล IOP measurements
    const [measurements] = await pool.execute(
      `SELECT iop.measurement_id, iop.measurement_date, iop.measurement_time,
              iop.left_eye_iop, iop.right_eye_iop, iop.measurement_method, iop.notes,
              CONCAT(d.first_name, ' ', d.last_name) as measured_by
       FROM IOP_Measurements iop
       LEFT JOIN DoctorProfiles d ON iop.doctor_id = d.doctor_id
       ${whereClause}
       ORDER BY iop.measurement_date DESC, iop.measurement_time DESC
       ${limitClause}`,
      queryParams
    );

    // คำนวณสถิติ
    const stats = {
      total_measurements: measurements.length,
      latest_measurement: measurements[0] || null,
      average_left: null,
      average_right: null,
      max_left: null,
      max_right: null,
      min_left: null,
      min_right: null
    };

    if (measurements.length > 0) {
      const leftValues = measurements.filter(m => m.left_eye_iop !== null).map(m => m.left_eye_iop);
      const rightValues = measurements.filter(m => m.right_eye_iop !== null).map(m => m.right_eye_iop);

      if (leftValues.length > 0) {
        stats.average_left = (leftValues.reduce((a, b) => a + b, 0) / leftValues.length).toFixed(1);
        stats.max_left = Math.max(...leftValues);
        stats.min_left = Math.min(...leftValues);
      }

      if (rightValues.length > 0) {
        stats.average_right = (rightValues.reduce((a, b) => a + b, 0) / rightValues.length).toFixed(1);
        stats.max_right = Math.max(...rightValues);
        stats.min_right = Math.min(...rightValues);
      }
    }

    res.json({
      measurements,
      stats,
      patient_name: `${patientExists[0].first_name} ${patientExists[0].last_name}`
    });

  } catch (error) {
    console.error('❌ Error loading IOP measurements:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete IOP measurement
app.delete('/api/iop-measurements/:measurementId', authDoctor, async (req, res) => {
  try {
    const measurementId = req.params.measurementId;
    const doctorId = req.doctor.doctor_id;

    // ตรวจสอบว่า measurement มีอยู่และเป็นของหมอคนนี้
    const [measurement] = await pool.execute(
      `SELECT measurement_id, patient_id FROM IOP_Measurements 
       WHERE measurement_id = ? AND doctor_id = ?`,
      [measurementId, doctorId]
    );

    if (measurement.length === 0) {
      return res.status(404).json({ error: 'IOP measurement not found or unauthorized' });
    }

    // ลบ measurement
    await pool.execute(
      'DELETE FROM IOP_Measurements WHERE measurement_id = ?',
      [measurementId]
    );

    res.json({ message: 'IOP measurement deleted successfully' });

  } catch (error) {
    console.error('❌ Error deleting IOP measurement:', error);
    res.status(500).json({ error: error.message });
  }
});

console.log('✅ IOP measurement endpoints added successfully');

// ===========================================
// APPOINTMENT MANAGEMENT ROUTES
// ===========================================

// Get all appointments for the doctor
app.get('/api/appointments', authDoctor, async (req, res) => {
  try {
    const doctorId = req.doctor.doctor_id;
    const { status, date, patient_id, limit } = req.query;

    console.log(`📅 Loading appointments for doctor: ${doctorId}`);

    let whereClause = 'WHERE a.doctor_id = ?';
    let queryParams = [doctorId];

    // Apply filters
    if (status) {
      whereClause += ' AND a.appointment_status = ?';
      queryParams.push(status);
    }
    
    if (date) {
      whereClause += ' AND a.appointment_date = ?';
      queryParams.push(date);
    }
    
    if (patient_id) {
      whereClause += ' AND a.patient_id = ?';
      queryParams.push(patient_id);
    }

    const limitClause = limit ? `LIMIT ${parseInt(limit)}` : '';

    const [appointments] = await pool.execute(
      `SELECT a.appointment_id, a.patient_id, a.appointment_date, a.appointment_time,
              a.appointment_type, a.appointment_status, a.notes, a.created_at,
              CONCAT(p.first_name, ' ', p.last_name) as patient_name,
              p.hn as patient_hn
       FROM Appointments a
       LEFT JOIN PatientProfiles p ON a.patient_id = p.patient_id
       ${whereClause}
       ORDER BY a.appointment_date ASC, a.appointment_time ASC
       ${limitClause}`,
      queryParams
    );

    console.log(`✅ Found ${appointments.length} appointments`);
    res.json(appointments);

  } catch (error) {
    console.error('Error getting appointments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new appointment
app.post('/api/appointments', authDoctor, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const doctorId = req.doctor.doctor_id;
    const {
      patient_id,
      appointment_date,
      appointment_time,
      appointment_type,
      notes,
      appointment_status
    } = req.body;

    console.log('📅 Creating new appointment:', {
      patient_id,
      appointment_date,
      appointment_time,
      appointment_type
    });

    // Validation
    if (!patient_id || !appointment_date || !appointment_time || !appointment_type) {
      await connection.rollback();
      return res.status(400).json({ 
        error: 'กรุณากรอกข้อมูลให้ครบถ้วน (ผู้ป่วย, วันที่, เวลา, ประเภท)' 
      });
    }

    // Check if patient exists
    const [patientExists] = await connection.execute(
      'SELECT patient_id, first_name, last_name FROM PatientProfiles WHERE patient_id = ?',
      [patient_id]
    );

    if (patientExists.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'ไม่พบข้อมูลผู้ป่วย' });
    }

    // Check for conflicting appointments (same doctor, same time)
    const [conflicts] = await connection.execute(
      `SELECT appointment_id FROM Appointments 
       WHERE doctor_id = ? AND appointment_date = ? AND appointment_time = ? 
       AND appointment_status NOT IN ('cancelled', 'completed')`,
      [doctorId, appointment_date, appointment_time]
    );

    if (conflicts.length > 0) {
      await connection.rollback();
      return res.status(400).json({ 
        error: 'มีนัดหมายในเวลานี้แล้ว กรุณาเลือกเวลาอื่น' 
      });
    }

    // Create doctor-patient relationship if not exists
    let [relationship] = await connection.execute(
      `SELECT relationship_id FROM DoctorPatientRelationships
       WHERE doctor_id = ? AND patient_id = ?`,
      [doctorId, patient_id]
    );

    if (relationship.length === 0) {
      const relationshipId = uuidv4();
      await connection.execute(
        `INSERT INTO DoctorPatientRelationships 
         (relationship_id, doctor_id, patient_id, start_date, status)
         VALUES (?, ?, ?, CURDATE(), 'active')`,
        [relationshipId, doctorId, patient_id]
      );
      console.log(`✅ Created doctor-patient relationship`);
    }

    // Create appointment
    const appointmentId = uuidv4();
    await connection.execute(
      `INSERT INTO Appointments (
        appointment_id, patient_id, doctor_id, appointment_date, appointment_time,
        appointment_type, appointment_location, appointment_duration, 
        appointment_status, cancellation_reason, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        appointmentId,
        patient_id,
        doctorId,
        appointment_date,
        appointment_time,
        appointment_type,
        'ห้องตรวจ 201',           // appointment_location
        30,                       // appointment_duration (นาที)
        appointment_status || 'scheduled',
        null,                     // cancellation_reason (NULL เพราะเป็นนัดใหม่)
        notes || null,            // notes
        doctorId                  // created_by (ใช้ doctor_id)
      ]
    );
    await connection.commit();

    console.log(`✅ Appointment created successfully: ${appointmentId}`);
    res.status(201).json({
      appointmentId,
      message: 'สร้างนัดหมายเรียบร้อยแล้ว',
      appointment: {
        appointment_id: appointmentId,
        patient_name: `${patientExists[0].first_name} ${patientExists[0].last_name}`,
        appointment_date,
        appointment_time,
        appointment_type,
        appointment_status: appointment_status || 'scheduled'
      }
    });

  } catch (error) {
    await connection.rollback();
    console.error('❌ Error creating appointment:', error);
    res.status(500).json({ 
      error: 'ไม่สามารถสร้างนัดหมายได้: ' + error.message 
    });
  } finally {
    connection.release();
  }
});

// Update appointment
app.put('/api/appointments/:appointmentId', authDoctor, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const appointmentId = req.params.appointmentId;
    const doctorId = req.doctor.doctor_id;
    const {
      appointment_date,
      appointment_time,
      appointment_type,
      appointment_status,
      notes
    } = req.body;

    console.log(`📅 Updating appointment: ${appointmentId}`);

    // Check if appointment exists and belongs to doctor
    const [existingAppointment] = await connection.execute(
      `SELECT appointment_id, patient_id, appointment_status 
       FROM Appointments 
       WHERE appointment_id = ? AND doctor_id = ?`,
      [appointmentId, doctorId]
    );

    if (existingAppointment.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'ไม่พบนัดหมายนี้หรือคุณไม่มีสิทธิ์แก้ไข' });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (appointment_date) {
      updateFields.push('appointment_date = ?');
      updateValues.push(appointment_date);
    }
    if (appointment_time) {
      updateFields.push('appointment_time = ?');
      updateValues.push(appointment_time);
    }
    if (appointment_type) {
      updateFields.push('appointment_type = ?');
      updateValues.push(appointment_type);
    }
    if (appointment_status) {
      updateFields.push('appointment_status = ?');
      updateValues.push(appointment_status);
    }
    if (notes !== undefined) {
      updateFields.push('notes = ?');
      updateValues.push(notes);
    }

    if (updateFields.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'ไม่มีข้อมูลที่ต้องการแก้ไข' });
    }

    // Add updated_at field
    updateFields.push('updated_at = NOW()');
    updateValues.push(appointmentId);

    // Execute update
    await connection.execute(
      `UPDATE Appointments SET ${updateFields.join(', ')} WHERE appointment_id = ?`,
      updateValues
    );

    await connection.commit();

    console.log(`✅ Appointment updated successfully: ${appointmentId}`);
    res.json({ 
      message: 'แก้ไขนัดหมายเรียบร้อยแล้ว',
      appointmentId 
    });

  } catch (error) {
    await connection.rollback();
    console.error('❌ Error updating appointment:', error);
    res.status(500).json({ 
      error: 'ไม่สามารถแก้ไขนัดหมายได้: ' + error.message 
    });
  } finally {
    connection.release();
  }
});

// Get upcoming appointments (for dashboard)
app.get('/api/appointments/upcoming', authDoctor, async (req, res) => {
  try {
    const doctorId = req.doctor.doctor_id;
    const days = parseInt(req.query.days) || 7;
    
    console.log(`📅 Loading upcoming appointments for doctor: ${doctorId} (${days} days)`);

    const [appointments] = await pool.execute(`
      SELECT a.appointment_id, a.appointment_date, a.appointment_time,
             a.appointment_type, a.appointment_status,
             CONCAT(p.first_name, ' ', p.last_name) as patient_name,
             p.hn as patient_hn
      FROM Appointments a
      JOIN PatientProfiles p ON a.patient_id = p.patient_id
      WHERE a.doctor_id = ? 
        AND a.appointment_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
        AND a.appointment_status IN ('scheduled', 'confirmed', 'rescheduled')
      ORDER BY a.appointment_date ASC, a.appointment_time ASC
    `, [doctorId, days]);
    
    console.log(`✅ Found ${appointments.length} upcoming appointments`);
    res.json(appointments);

  } catch (error) {
    console.error('Error getting upcoming appointments:', error);
    res.status(500).json({ error: error.message });
  }
});

console.log('✅ Appointment management endpoints added successfully');
console.log('🔧 Available appointment endpoints:');
console.log('   GET /api/appointments - Get all appointments');
console.log('   POST /api/appointments - Create new appointment');
console.log('   PUT /api/appointments/:id - Update appointment');
console.log('   GET /api/appointments/upcoming - Get upcoming appointments');

// ===========================================
// ERROR HANDLING MIDDLEWARE
// ===========================================

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ error: error.message });
  }
  
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ===========================================
// SERVER STARTUP
// ===========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
🚀 Doctor API Server is running on port ${PORT}
📊 Database: ${process.env.DB_NAME || 'glaucoma_management_system'}
🌐 Environment: ${process.env.NODE_ENV || 'development'}
📧 Email notifications: ${process.env.EMAIL_USER ? 'Enabled' : 'Disabled'}
⏰ Automated monitoring: Active
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

module.exports = app;