const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const csvParser = require('csv-parser');
const multer = require('multer');
const session = require('express-session');
const FileStore = require('session-file-store')(session); // Add file store for sessions
const bcrypt = require('bcryptjs');
const json2csv = require('json2csv').Parser;
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const isRender = process.env.RENDER ? true : false;

// Important for production with Render - trust proxy
app.set('trust proxy', 1);

// Debug environment info
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`Production mode: ${isProduction}`);
console.log(`Port: ${port}`);
console.log(`Platform: ${process.env.RENDER ? 'Render' : (process.env.RAILWAY_STATIC_URL ? 'Railway' : 'Other')}`);
console.log(`Session secret length: ${(process.env.SESSION_SECRET || 'default-secret').length} chars`);

// RENDER BYPASS: Create a simplified auth store since Render has issues with session cookies
const authStore = {
  adminAuthenticated: false,
  lastLoginTime: null,
  loginIP: null
};

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'election-voter-validation-secret',
  resave: true,
  saveUninitialized: true,
  cookie: {
    // Never use secure cookies on Render regardless of environment
    secure: isRender ? false : isProduction,
    sameSite: 'lax',
    maxAge: 3600000, // 1 hour
    // Don't set domain for Render
    domain: undefined
  },
  store: new FileStore({
    path: isRender ? '/tmp/sessions' : path.join(__dirname, 'data', 'sessions'),
    ttl: 86400, // 1 day
    retries: 0,
    logFn: function(){} // Disable session store logs
  })
}));

// Simplified alternative auth check middleware for Render
function renderAuth(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress;
  console.log(`Auth check - Session: ${req.session.isAuthenticated ? 'Yes' : 'No'}, Global: ${authStore.adminAuthenticated ? 'Yes' : 'No'}, IP: ${clientIP}, Last login IP: ${authStore.loginIP}`);

  // Use either normal session or global auth store on Render
  if (req.session.isAuthenticated || (isRender && authStore.adminAuthenticated && clientIP === authStore.loginIP)) {
    if (!req.session.isAuthenticated && isRender) {
      console.log("Using global auth store instead of session");
      req.session.isAuthenticated = true;
    }
    return next();
  }

  console.log('User not authenticated, redirecting to login');
  res.redirect('/login');
}

// Ensure directories exist - use relative paths for better compatibility with Railway
fs.ensureDirSync(path.join(__dirname, 'uploads'));
fs.ensureDirSync(path.join(__dirname, 'data'));
fs.ensureDirSync(path.join(__dirname, 'public'));

// Set up file upload storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    // Determine file extension
    const fileExt = path.extname(file.originalname);
    cb(null, 'voter_register' + fileExt);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Accept only CSV and Excel files
    if (file.mimetype === 'text/csv' ||
        file.mimetype === 'application/vnd.ms-excel' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'), false);
    }
  }
});

// Store for votes and admin credentials - use Railway_VOLUME_MOUNT_PATH if available
const dataDirectory = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
  : path.join(__dirname, 'data');
const uploadsDirectory = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, 'uploads');

// Make sure these directories exist
fs.ensureDirSync(dataDirectory);
fs.ensureDirSync(uploadsDirectory);

// Set file paths based on the configured directories
const votesFile = path.join(dataDirectory, 'votes.json');
const adminFile = path.join(dataDirectory, 'admin.json');

console.log(`Data directory: ${dataDirectory}`);
console.log(`Uploads directory: ${uploadsDirectory}`);
console.log(`Votes file path: ${votesFile}`);
console.log(`Admin file path: ${adminFile}`);

// Function to initialize admin if file doesn't exist or is corrupted
const initializeAdmin = () => {
  try {
    // Try to read the existing admin file
    if (fs.existsSync(adminFile)) {
      const admin = fs.readJsonSync(adminFile);
      // Check if file has valid data
      if (admin && admin.admins && Array.isArray(admin.admins) && admin.admins.length > 0) {
        console.log("Admin file exists and contains valid data.");
        return;
      } else {
        console.log("Admin file exists but has invalid format. Recreating...");
      }
    } else {
      // Create data directory if it doesn't exist
      if (!fs.existsSync(path.dirname(adminFile))) {
        fs.mkdirpSync(path.dirname(adminFile));
        console.log("Created data directory structure");
      }
    }

    // Create two admin accounts with different passwords
    const admins = [
      {
        username: 'admin1',
        passwordHash: bcrypt.hashSync('mmc2025admin1', 10),
        role: 'administrator',
        name: 'MMC Admin 1'
      },
      {
        username: 'admin2',
        passwordHash: bcrypt.hashSync('mmc2025admin2', 10),
        role: 'administrator',
        name: 'MMC Admin 2'
      }
    ];

    fs.writeJsonSync(adminFile, { admins });
    console.log("Admin accounts created successfully");
  } catch (error) {
    console.error("Error initializing admin:", error);
  }
};

// Initialize files if they don't exist
if (!fs.existsSync(votesFile)) {
  // Create data directory if it doesn't exist
  if (!fs.existsSync(path.dirname(votesFile))) {
    fs.mkdirpSync(path.dirname(votesFile));
    console.log("Created data directory structure for votes");
  }
  fs.writeJsonSync(votesFile, []);
  console.log("Votes file initialized");
}

// Initialize admin (with improved error handling)
initializeAdmin();

// Function to check if a file exists
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    console.error(`Error checking if file exists at ${filePath}:`, error);
    return false;
  }
}

// Function to get voter register details
async function getVoterRegister() {
  try {
    console.log(`Looking for voter register in: ${uploadsDirectory}`);

    // Check all possible file names and extensions
    const possibleFiles = [
      path.join(uploadsDirectory, 'voter_register.xlsx'),
      path.join(uploadsDirectory, 'voter_register.xls'),
      path.join(uploadsDirectory, 'voter_register.csv')
    ];

    // Debug info
    possibleFiles.forEach(file => {
      console.log(`Checking for: ${file}, exists: ${fileExists(file)}`);
    });

    // Try Excel files first
    for (const filePath of possibleFiles.filter(p => p.endsWith('.xlsx') || p.endsWith('.xls'))) {
      if (fileExists(filePath)) {
        console.log(`Found Excel voter register at: ${filePath}`);
        return await parseExcelVoterRegister(filePath);
      }
    }

    // Then try CSV
    const csvPath = possibleFiles.find(p => p.endsWith('.csv'));
    if (csvPath && fileExists(csvPath)) {
      console.log(`Found CSV voter register at: ${csvPath}`);
      return await parseCSVVoterRegister(csvPath);
    }

    console.log("No voter register found. Returning empty array.");
    return [];
  } catch (error) {
    console.error('Error getting voter register:', error);
    return [];
  }
}

// Function to parse Excel voter register
async function parseExcelVoterRegister(filePath) {
  try {
    console.log(`Parsing Excel file: ${filePath}`);
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    console.log(`Successfully parsed Excel file with ${data.length} records`);
    return data;
  } catch (error) {
    console.error('Error parsing Excel voter register:', error);
    return [];
  }
}

// Function to parse CSV voter register
async function parseCSVVoterRegister(filePath) {
  return new Promise((resolve, reject) => {
    try {
      console.log(`Parsing CSV file: ${filePath}`);
      const results = [];
      fs.createReadStream(filePath)
        .pipe(csvParser())
        .on('data', (data) => results.push(data))
        .on('end', () => {
          console.log(`Successfully parsed CSV file with ${results.length} records`);
          resolve(results);
        })
        .on('error', (error) => {
          console.error('Error parsing CSV:', error);
          reject(error);
        });
    } catch (error) {
      console.error('Error parsing CSV voter register:', error);
      resolve([]);
    }
  });
}

// Function to find membership number by name
async function findMembershipByName(name) {
  try {
    if (!name || name.trim() === '') {
      return [];
    }

    const register = await getVoterRegister();
    console.log('Register slice for debugging:', register.slice(0, 3));

    const searchName = name.toLowerCase().trim();
    console.log('Searching for name:', searchName);

    // Find all potential matches
    const matches = register.filter(voter => {
      // Try different possible column names for name
      const voterName =
        voter['NAME'] ||
        voter['Name'] ||
        voter['name'] ||
        voter['Full Name'] ||
        voter['FULL NAME'] ||
        voter['fullName'];

      console.log('Voter record:', voter);
      console.log('Voter name from record:', voterName);

      if (voterName && typeof voterName === 'string') {
        const voterNameLower = voterName.toLowerCase();
        const isMatch = voterNameLower.includes(searchName);
        console.log(`Comparing "${voterNameLower}" with "${searchName}": ${isMatch}`);
        return isMatch;
      }

      // If no name column found, check other columns for the name
      const hasNameInOtherField = Object.entries(voter).some(([key, value]) => {
        if (typeof value === 'string' && key !== 'MMC NO.' && key !== 'TEL NO.') {
          const valueLower = value.toLowerCase();
          const isMatch = valueLower.includes(searchName);
          console.log(`Checking field "${key}" with value "${valueLower}": ${isMatch}`);
          return isMatch;
        }
        return false;
      });

      return hasNameInOtherField;
    });

    console.log('Found matches:', matches.length);

    // Format the results
    return matches.map(voter => {
      const membershipNumber =
        voter['MMC NO.'] ||
        voter['M/SHIP NO.'] ||
        voter['Membership Number'] ||
        voter['MEMBERSHIP NUMBER'] ||
        voter['membershipNumber'] ||
        voter['Membership number'] ||
        voter['membership number'] ||
        voter['MembershipNumber'] ||
        Object.values(voter)[0];

      const name =
        voter['NAME'] ||
        voter['Name'] ||
        voter['name'] ||
        voter['Full Name'] ||
        voter['FULL NAME'] ||
        voter['fullName'] ||
        Object.values(voter).find(v => typeof v === 'string' && v !== membershipNumber);

      return {
        membershipNumber: membershipNumber ? String(membershipNumber).trim() : 'Unknown',
        name: name ? String(name).trim() : 'Unknown'
      };
    });
  } catch (error) {
    console.error('Error finding membership by name:', error);
    return [];
  }
}

// Function to check if a membership number is valid
async function isValidMembershipNumber(membershipNumber) {
  try {
    const register = await getVoterRegister();

    // Debug log to see what's in the register
    console.log('Register entries:', register.slice(0, 3));

    // Check for membership number in different possible column names
    return register.some(voter => {
      // Try different possible column names for membership number
      const membershipValue =
        voter['MMC NO.'] ||
        voter['M/SHIP NO.'] ||
        voter['Membership Number'] ||
        voter['MEMBERSHIP NUMBER'] ||
        voter['membershipNumber'] ||
        voter['Membership number'] ||
        voter['membership number'] ||
        voter['MembershipNumber'];

      // If we found a value, compare it with the input
      if (membershipValue !== undefined) {
        const membershipValueStr = String(membershipValue).trim();
        const inputValueStr = String(membershipNumber).trim();
        console.log(`Comparing: "${membershipValueStr}" with "${inputValueStr}"`);
        return membershipValueStr === inputValueStr;
      }

      // If no column with membership number found, check the first column
      // This handles cases where the CSV might not have proper headers
      const firstColumnValue = Object.values(voter)[0];
      if (firstColumnValue !== undefined) {
        const firstColumnValueStr = String(firstColumnValue).trim();
        const inputValueStr = String(membershipNumber).trim();
        console.log(`Comparing first column: "${firstColumnValueStr}" with "${inputValueStr}"`);
        return firstColumnValueStr === inputValueStr;
      }

      return false;
    });
  } catch (error) {
    console.error('Error validating membership number:', error);
    return false;
  }
}

// Function to validate membership number with phone number
async function validateMembershipWithPhone(membershipNumber, phoneNumber) {
  try {
    const register = await getVoterRegister();

    // Debug log more detailed information about the register
    console.log(`Validating membershipNumber: ${membershipNumber}, phoneNumber: ${phoneNumber}`);
    console.log('First few voter register entries:');
    register.slice(0, 3).forEach((voter, index) => {
      console.log(`Register entry ${index}:`, JSON.stringify(voter));
    });

    // Format the phone number input to strip any non-numeric characters
    const formattedInputPhone = phoneNumber.replace(/\D/g, '');

    // Track if we found the membership number but phone didn't match
    let foundMembershipButPhoneDidntMatch = false;
    let matchedMembership = null;

    // Check for membership number and phone number in different possible column names
    const matchResult = register.some(voter => {
      // Try different possible column names for membership number
      const membershipValue =
        voter['MMC NO.'] ||
        voter['M/SHIP NO.'] ||
        voter['Membership Number'] ||
        voter['MEMBERSHIP NUMBER'] ||
        voter['membershipNumber'] ||
        voter['Membership number'] ||
        voter['membership number'] ||
        voter['MembershipNumber'];

      // Try different possible column names for phone number
      const phoneValue =
        voter['TEL NO.'] ||
        voter['TELEPHONE'] ||
        voter['Phone Number'] ||
        voter['phone number'] ||
        voter['Phone'] ||
        voter['phone'] ||
        voter['MOBILE NO.'] ||
        voter['Mobile'] ||
        voter['mobile'];

      // Format the phone number from register to strip any non-numeric characters
      const formattedRegisterPhone = phoneValue ? String(phoneValue).replace(/\D/g, '') : '';

      // Log detailed information for each potential match
      if (membershipValue) {
        const membershipValueStr = String(membershipValue).trim();
        const inputValueStrMembership = String(membershipNumber).trim();

        if (membershipValueStr === inputValueStrMembership) {
          matchedMembership = voter;
          console.log('FOUND MATCHING MEMBERSHIP NUMBER:');
          console.log('Register entry:', JSON.stringify(voter));
          console.log(`Register phone: ${phoneValue} (formatted: ${formattedRegisterPhone})`);
          console.log(`Input phone: ${phoneNumber} (formatted: ${formattedInputPhone})`);

          if (formattedRegisterPhone !== formattedInputPhone) {
            foundMembershipButPhoneDidntMatch = true;
            console.log('WARNING: PHONE NUMBER DOES NOT MATCH!');
            return false;
          }
          return true;
        }
      }

      return false;
    });

    if (foundMembershipButPhoneDidntMatch) {
      return {
        valid: false,
        message: 'The phone number provided does not match our records for this membership number.'
      };
    }

    if (!matchedMembership) {
      return {
        valid: false,
        message: 'Membership number not found in our records.'
      };
    }

    return { valid: matchResult, message: '' };
  } catch (error) {
    console.error('Error validating membership with phone:', error);
    return { valid: false, message: 'An error occurred while validating membership with phone.' };
  }
}

// Function to check if a membership number has already voted
async function hasAlreadyVoted(membershipNumber) {
  try {
    const votes = fs.readJsonSync(votesFile);
    return votes.some(vote => vote.membershipNumber === membershipNumber);
  } catch (error) {
    console.error('Error checking if already voted:', error);
    return false;
  }
}

// Function to check if an email has already voted
async function hasEmailAlreadyVoted(email) {
  try {
    const votes = fs.readJsonSync(votesFile);
    console.log(`Checking if email "${email}" has already voted...`);
    console.log(`Found ${votes.length} total votes in the system`);

    // Normalize the email to lowercase for case-insensitive comparison
    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists in votes
    const emailExists = votes.some(vote => {
      const voteEmail = vote.email.toLowerCase().trim();
      const matches = voteEmail === normalizedEmail;
      console.log(`Comparing: "${voteEmail}" with "${normalizedEmail}": ${matches}`);
      return matches;
    });

    console.log(`Email "${email}" already voted: ${emailExists}`);
    return emailExists;
  } catch (error) {
    console.error('Error checking if email already voted:', error);
    return false;
  }
}

// Function to validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Function to record a vote
async function recordVote(voteData) {
  try {
    const votes = fs.readJsonSync(votesFile);
    votes.push({
      ...voteData,
      timestamp: new Date().toISOString()
    });
    fs.writeJsonSync(votesFile, votes);
    return true;
  } catch (error) {
    console.error('Error recording vote:', error);
    return false;
  }
}

// Email configuration
const emailConfig = {
  // For production, use actual SMTP service
  // For development/testing, use ethereal.email (test service)
  service: process.env.EMAIL_SERVICE || 'Gmail',
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER || 'hillariouskelly@gmail.com', // Update with actual email
    pass: process.env.EMAIL_PASS || 'uwoqkfhhdpxhigwx' // Update with actual password
  }
};

// Email transporter
let transporter;
try {
  transporter = nodemailer.createTransport(emailConfig);
  console.log('Email transporter initialized');
} catch (error) {
  console.error('Failed to initialize email transporter:', error);
}

// Function to send vote confirmation email
async function sendVoteConfirmationEmail(email, membershipNumber) {
  // Skip sending emails if transporter isn't initialized
  if (!transporter) {
    console.warn('Email transporter not initialized, skipping email send');
    return false;
  }
  
  try {
    // Format date for the email
    const dateOptions = { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    };
    const formattedDate = new Date().toLocaleDateString('en-GB', dateOptions);
    
    // Get the app's public URL
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    
    // Create email HTML content
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="${appUrl}/images/cropped-LOGO.png" alt="MMC Logo" style="max-height: 80px; margin: 0 auto;">
          <h2 style="color: #333; margin-top: 15px;">Mombasa Memorial Cathedral</h2>
          <h3 style="color: #555; margin-top: 5px;">Voting System</h3>
        </div>
        <h2 style="color: #333; text-align: center;">Election Vote Confirmation</h2>
        <p>Dear MMC Member,</p>
        <p>Thank you for participating in the MMC 2025 election. This email confirms that your vote has been successfully recorded.</p>
        <div style="background-color: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 5px;">
          <p><strong>Membership Number:</strong> ${membershipNumber}</p>
          <p><strong>Vote Date/Time:</strong> ${formattedDate}</p>
        </div>
        <p>Your participation in this election is important to MMC. If you did not vote or have any concerns, please contact the election committee immediately.</p>
        <p>Thank you,<br>MMC Election Committee</p>
        <div style="font-size: 12px; color: #777; margin-top: 30px; border-top: 1px solid #e0e0e0; padding-top: 15px;">
          <p>This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `;
    
    // Send email
    const mailOptions = {
      from: `"MMC Elections" <${emailConfig.auth.user}>`,
      to: email,
      subject: 'MMC Election Vote Confirmation',
      html: htmlContent
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log(`Vote confirmation email sent to ${email}: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error('Error sending vote confirmation email:', error);
    return false;
  }
}

// Authentication middleware
function requireAuth(req, res, next) {
  console.log(`Session auth check: ${req.session.isAuthenticated ? 'Authenticated' : 'Not authenticated'}`);

  if (req.session.isAuthenticated) {
    return next();
  }

  console.log('User not authenticated, redirecting to login');
  res.redirect('/login');
}

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/login', (req, res) => {
  // If already authenticated, redirect to admin
  if (req.session.isAuthenticated) {
    console.log('User already authenticated, redirecting to admin');
    return res.redirect('/admin');
  }
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;

  try {
    // Check if admin file exists, initialize if not
    if (!fs.existsSync(adminFile)) {
      console.log("Admin file not found during login attempt, initializing...");
      initializeAdmin();
    }

    // Read admin credentials
    const adminData = fs.readJsonSync(adminFile);
    console.log(`Login attempt for username: ${username} from IP: ${clientIP}`);

    // Find matching admin
    const matchingAdmin = adminData.admins.find(admin => admin.username === username);

    if (matchingAdmin && bcrypt.compareSync(password, matchingAdmin.passwordHash)) {
      console.log("Login successful");

      // Set both session and global auth for Render
      req.session.isAuthenticated = true;
      req.session.adminUsername = matchingAdmin.username;
      req.session.adminName = matchingAdmin.name || matchingAdmin.username;

      // For Render, also set the global auth store
      if (isRender) {
        authStore.adminAuthenticated = true;
        authStore.adminUsername = matchingAdmin.username;
        authStore.lastLoginTime = new Date().toISOString();
        authStore.loginIP = clientIP;
        console.log(`Global auth store updated: ${JSON.stringify(authStore)}`);
      }

      // Force save session before redirect
      req.session.save(err => {
        if (err) {
          console.error("Session save error:", err);
          return res.render('login', { error: 'Session error. Please try again.' });
        }
        console.log("Session saved successfully, redirecting to admin");

        // In Render environment, use a direct rendering approach instead of redirect
        if (isRender) {
          console.log("Using direct render approach for Render environment");
          return res.render('admin');
        } else {
          return res.redirect('/admin');
        }
      });
    } else {
      console.log("Login failed: invalid credentials");
      res.render('login', { error: 'Invalid username or password' });
    }
  } catch (error) {
    console.error("Login error:", error);
    res.render('login', { error: 'An error occurred. Please try again later.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/admin', renderAuth, (req, res) => {
  console.log('Admin dashboard accessed');
  res.render('admin');
});

app.get('/vote', (req, res) => {
  res.render('vote');
});

app.get('/forgot-membership', (req, res) => {
  res.render('forgot-membership');
});

// API endpoint to validate membership number
app.post('/api/validate-membership', async (req, res) => {
  const { membershipNumber, phoneNumber, email } = req.body;

  if (!membershipNumber) {
    return res.status(400).json({ valid: false, message: 'Membership number is required' });
  }

  if (!phoneNumber) {
    return res.status(400).json({ valid: false, message: 'Phone number is required' });
  }

  // Email is still required for internal tracking but is generated on the client side if not provided
  if (!email) {
    return res.status(400).json({ valid: false, message: 'Email is required for tracking (internal use)' });
  }

  // Validate email format
  if (!isValidEmail(email)) {
    return res.status(400).json({
      valid: false,
      message: 'Invalid email format. Please contact the administrator.'
    });
  }

  try {
    // Check if email has already been used - THIS CHECK MUST BE FIRST
    // We're still checking for unique emails to prevent duplicate votes
    const emailUsed = await hasEmailAlreadyVoted(email);
    console.log(`Email used check result: ${emailUsed}`);

    if (emailUsed) {
      console.log(`Rejecting validation because email ${email} has already been used`);
      return res.json({
        valid: false,
        message: 'This validation token has already been used. Please contact an administrator if you need assistance.'
      });
    }

    // Validate membership number with phone number
    const validationResult = await validateMembershipWithPhone(membershipNumber, phoneNumber);

    if (!validationResult.valid) {
      return res.json({
        valid: false,
        message: validationResult.message || 'Invalid membership number or phone number. Please check and try again.'
      });
    }

    const hasVoted = await hasAlreadyVoted(membershipNumber);

    if (hasVoted) {
      return res.json({
        valid: false,
        message: 'This membership number has already voted.'
      });
    }

    console.log(`Validation successful for membership: ${membershipNumber}, phone: ${phoneNumber}, email: ${email}`);
    return res.json({ valid: true });
  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({
      valid: false,
      message: 'An error occurred during validation. Please try again.'
    });
  }
});

// API endpoint to find membership by name
app.post('/api/find-membership', async (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, message: 'Name is required' });
  }

  try {
    const matches = await findMembershipByName(name);

    if (matches.length === 0) {
      return res.json({
        success: false,
        message: 'No membership found with that name. Please check spelling or contact an administrator.'
      });
    }

    return res.json({
      success: true,
      matches
    });
  } catch (error) {
    console.error('Find membership error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while searching. Please try again.'
    });
  }
});

// API endpoint to submit a vote
app.post('/api/submit-vote', async (req, res) => {
  const { membershipNumber, phoneNumber, email, votes } = req.body;

  if (!membershipNumber || !phoneNumber || !votes) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // Email is now auto-generated on the client side but still validated here for tracking
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required for tracking (internal use)' });
  }

  // Validate email format
  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid email format. Please contact the administrator.'
    });
  }

  try {
    // Validate membership number with phone number
    const validationResult = await validateMembershipWithPhone(membershipNumber, phoneNumber);

    if (!validationResult.valid) {
      return res.json({
        success: false,
        message: 'Invalid membership number or phone number. The phone number must match our records.'
      });
    }

    const hasVoted = await hasAlreadyVoted(membershipNumber);

    if (hasVoted) {
      return res.json({
        success: false,
        message: 'This membership number has already voted.'
      });
    }

    // Check if email has already been used to vote
    const emailUsed = await hasEmailAlreadyVoted(email);

    if (emailUsed) {
      return res.json({
        success: false,
        message: 'This validation token has already been used. Please contact an administrator if you need assistance.'
      });
    }

    const recorded = await recordVote({ membershipNumber, phoneNumber, email, votes });

    if (!recorded) {
      return res.status(500).json({
        success: false,
        message: 'Failed to record your vote. Please try again.'
      });
    }

    // Send vote confirmation email
    const emailSent = await sendVoteConfirmationEmail(email, membershipNumber);

    if (!emailSent) {
      console.log('Failed to send vote confirmation email');
    }

    return res.json({
      success: true,
      message: 'Your vote has been recorded successfully.'
    });
  } catch (error) {
    console.error('Vote submission error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while submitting your vote. Please try again.'
    });
  }
});

// API endpoint to upload voter register
app.post('/api/upload-register', renderAuth, upload.single('register'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  try {
    // Validate the file format
    const fileExt = path.extname(req.file.path).toLowerCase();
    if (fileExt !== '.csv' && fileExt !== '.xlsx' && fileExt !== '.xls') {
      fs.unlinkSync(req.file.path); // Delete invalid file
      return res.status(400).json({
        success: false,
        message: 'Invalid file format. Please upload a CSV or Excel file.'
      });
    }

    // Read and validate the register
    const register = await getVoterRegister();

    return res.json({
      success: true,
      message: 'Voter register uploaded successfully',
      count: register.length
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while processing the file. Please check the format and try again.'
    });
  }
});

// API endpoint to get voting statistics
app.get('/api/stats', renderAuth, async (req, res) => {
  try {
    const votes = fs.readJsonSync(votesFile);
    const register = await getVoterRegister();

    const stats = {
      totalVoters: register.length,
      totalVotes: votes.length,
      votingPercentage: register.length > 0 ? (votes.length / register.length * 100).toFixed(2) : 0
    };

    // Count votes for each option
    const voteCounts = {};
    votes.forEach(vote => {
      Object.entries(vote.votes).forEach(([question, answer]) => {
        // Skip old election positions (president, vicePresident, budgetProposal)
        if (question === 'president' || question === 'vicePresident' || question === 'budgetProposal') {
          return; // Skip these positions
        }

        if (!voteCounts[question]) {
          voteCounts[question] = {};
        }

        // Handle sidemen array specially
        if (question === 'sidemen' && Array.isArray(answer)) {
          answer.forEach(option => {
            if (!voteCounts[question][option]) {
              voteCounts[question][option] = 0;
            }
            voteCounts[question][option]++;
          });
        } else {
          if (!voteCounts[question][answer]) {
            voteCounts[question][answer] = 0;
          }
          voteCounts[question][answer]++;
        }
      });
    });

    stats.voteCounts = voteCounts;

    return res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while retrieving statistics.'
    });
  }
});

// API endpoint to export votes as Excel
app.get('/api/export-votes', requireAuth, async (req, res) => {
  try {
    const votes = fs.readJsonSync(votesFile);

    if (votes.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No votes to export'
      });
    }

    // Define active positions - keep in sync with the admin.ejs file
    const activePositions = [
      'deputyPeoplesWarden',
      'chairmanFinance'
    ];

    // Create a new workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Votes');

    // Flatten the votes data for Excel export
    const flattenedVotes = votes.map(vote => {
      const flatVote = {
        membershipNumber: vote.membershipNumber,
        phoneNumber: vote.phoneNumber,
        email: vote.email,
        timestamp: vote.timestamp
      };

      // Add only active positions as columns
      if (vote.votes) {
        Object.entries(vote.votes).forEach(([question, answer]) => {
          if (activePositions.includes(question)) {
            flatVote[formatColumnName(question)] = answer;
          }
        });
      }

      return flatVote;
    });

    // Get all possible fields (columns)
    const fields = [
      'membershipNumber', 
      'phoneNumber', 
      'email', 
      'timestamp', 
      ...activePositions.map(pos => formatColumnName(pos))
    ];

    // Add headers
    worksheet.columns = fields.map(field => ({
      header: field,
      key: field,
      width: field === 'timestamp' ? 30 : 20
    }));

    // Add rows
    flattenedVotes.forEach(vote => {
      worksheet.addRow(vote);
    });

    // Format header row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 20;

    // Auto-fit columns
    worksheet.columns.forEach(column => {
      column.width = Math.max(column.width, 15);
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=votes.xlsx');

    // Write to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting votes:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export votes. Please try again.'
    });
  }
});

// Helper function to format column names for the Excel export
function formatColumnName(camelCase) {
  // Convert camelCase to Title Case with spaces
  return camelCase
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase());
}

// API endpoint to change admin password
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'All fields are required' });
  }

  try {
    const adminData = fs.readJsonSync(adminFile);

    // Get username from session
    const username = req.session.adminUsername;
    
    if (!username) {
      return res.json({ success: false, message: 'Session error. Please log in again.' });
    }

    // Find the admin account
    const adminIndex = adminData.admins.findIndex(admin => admin.username === username);
    
    if (adminIndex === -1) {
      return res.json({ success: false, message: 'Admin account not found' });
    }
    
    const admin = adminData.admins[adminIndex];

    // Verify current password
    if (!bcrypt.compareSync(currentPassword, admin.passwordHash)) {
      return res.json({ success: false, message: 'Current password is incorrect' });
    }

    // Update password
    adminData.admins[adminIndex].passwordHash = bcrypt.hashSync(newPassword, 10);
    fs.writeJsonSync(adminFile, adminData);

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing password:', error);
    return res.status(500).json({ success: false, message: 'An error occurred while changing the password' });
  }
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`Voter validation app listening at http://localhost:${port}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
});
