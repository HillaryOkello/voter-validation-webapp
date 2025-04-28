const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const csvParser = require('csv-parser');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const json2csv = require('json2csv').Parser;
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Important for production with Render - trust proxy
app.set('trust proxy', 1);

// Debug environment info
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`Production mode: ${isProduction}`);
console.log(`Port: ${port}`);
console.log(`Platform: ${process.env.RENDER ? 'Render' : (process.env.RAILWAY_STATIC_URL ? 'Railway' : 'Other')}`);
console.log(`Session secret length: ${(process.env.SESSION_SECRET || 'default-secret').length} chars`);

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'election-voter-validation-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    // Only set secure: true if we're behind HTTPS (detected via X-Forwarded-Proto)
    secure: isProduction && process.env.RENDER ? false : isProduction,
    sameSite: 'lax',
    maxAge: 3600000, // 1 hour
    // Allow cookie to work on Render's domain
    domain: process.env.RENDER ? '.onrender.com' : undefined
  }
}));

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
      if (admin && admin.username && admin.passwordHash) {
        console.log("Admin file exists and contains valid data.");
        return;
      } else {
        console.log("Admin file exists but contains invalid data. Recreating...");
      }
    } else {
      console.log("Admin file doesn't exist. Creating default admin...");
    }
    
    // Create data directory if it doesn't exist
    if (!fs.existsSync(path.dirname(adminFile))) {
      fs.mkdirpSync(path.dirname(adminFile));
      console.log("Created data directory structure");
    }
    
    // Create default admin credentials (username: admin, password: admin123)
    const defaultAdmin = {
      username: 'admin',
      // Hash the password
      passwordHash: bcrypt.hashSync('admin123', 10)
    };
    
    fs.writeJsonSync(adminFile, defaultAdmin);
    console.log("Default admin created successfully");
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

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session.isAuthenticated) {
    return next();
  }
  res.redirect('/login');
}

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    // Check if admin file exists, initialize if not
    if (!fs.existsSync(adminFile)) {
      console.log("Admin file not found during login attempt, initializing...");
      initializeAdmin();
    }
    
    // Read admin credentials
    const admin = fs.readJsonSync(adminFile);
    console.log(`Login attempt for username: ${username}`);
    
    if (username === admin.username && bcrypt.compareSync(password, admin.passwordHash)) {
      console.log("Login successful");
      req.session.isAuthenticated = true;
      
      // Force save session before redirect
      req.session.save(err => {
        if (err) {
          console.error("Session save error:", err);
          return res.render('login', { error: 'Session error. Please try again.' });
        }
        console.log("Session saved successfully, redirecting to admin");
        return res.redirect('/admin');
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

app.get('/admin', requireAuth, (req, res) => {
  res.render('admin');
});

app.get('/vote', (req, res) => {
  res.render('vote');
});

// Comment out the forgot-membership route for security reasons
// app.get('/forgot-membership', (req, res) => {
//   res.render('forgot-membership');
// });

// API endpoint to validate membership number
app.post('/api/validate-membership', async (req, res) => {
  const { membershipNumber, email } = req.body;
  
  if (!membershipNumber) {
    return res.status(400).json({ valid: false, message: 'Membership number is required' });
  }
  
  if (!email) {
    return res.status(400).json({ valid: false, message: 'Email address is required' });
  }
  
  // Validate email format
  if (!isValidEmail(email)) {
    return res.status(400).json({ 
      valid: false, 
      message: 'Invalid email format. Please enter a valid email address.' 
    });
  }
  
  try {
    // Check if email has already been used - THIS CHECK MUST BE FIRST
    const emailUsed = await hasEmailAlreadyVoted(email);
    console.log(`Email used check result: ${emailUsed}`);
    
    if (emailUsed) {
      console.log(`Rejecting validation because email ${email} has already been used`);
      return res.json({ 
        valid: false, 
        message: 'This email address has already been used to vote. Each voter must use a unique email.' 
      });
    }
    
    // Only perform these checks if email hasn't been used
    const isValid = await isValidMembershipNumber(membershipNumber);
    
    if (!isValid) {
      return res.json({ 
        valid: false, 
        message: 'Invalid membership number. Please check and try again.' 
      });
    }
    
    const hasVoted = await hasAlreadyVoted(membershipNumber);
    
    if (hasVoted) {
      return res.json({ 
        valid: false, 
        message: 'This membership number has already voted.' 
      });
    }
    
    console.log(`Validation successful for membership: ${membershipNumber}, email: ${email}`);
    return res.json({ valid: true });
  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({ 
      valid: false, 
      message: 'An error occurred during validation. Please try again.' 
    });
  }
});

// API endpoint to find membership by name - commented out for security reasons
// app.post('/api/find-membership', async (req, res) => {
//   const { name } = req.body;
//   
//   if (!name) {
//     return res.status(400).json({ success: false, message: 'Name is required' });
//   }
//   
//   try {
//     const matches = await findMembershipByName(name);
//     
//     if (matches.length === 0) {
//       return res.json({ 
//         success: false, 
//         message: 'No membership found with that name. Please check spelling or contact an administrator.' 
//       });
//     }
//     
//     return res.json({ 
//       success: true, 
//       matches 
//     });
//   } catch (error) {
//     console.error('Find membership error:', error);
//     return res.status(500).json({ 
//       success: false, 
//       message: 'An error occurred while searching. Please try again.' 
//     });
//   }
// });

// API endpoint to submit a vote
app.post('/api/submit-vote', async (req, res) => {
  const { membershipNumber, email, votes } = req.body;
  
  if (!membershipNumber || !email || !votes) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  
  // Validate email format
  if (!isValidEmail(email)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid email format. Please enter a valid email address.' 
    });
  }
  
  try {
    const isValid = await isValidMembershipNumber(membershipNumber);
    
    if (!isValid) {
      return res.json({ 
        success: false, 
        message: 'Invalid membership number. Please check and try again.' 
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
        message: 'This email address has already been used to vote. Each voter must use a unique email.' 
      });
    }
    
    const recorded = await recordVote({ membershipNumber, email, votes });
    
    if (!recorded) {
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to record your vote. Please try again.' 
      });
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
app.post('/api/upload-register', requireAuth, upload.single('register'), async (req, res) => {
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
app.get('/api/stats', requireAuth, async (req, res) => {
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
    
    // Create a new workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Votes');
    
    // Flatten the votes data for Excel export
    const flattenedVotes = votes.map(vote => {
      const flatVote = {
        membershipNumber: vote.membershipNumber,
        email: vote.email,
        timestamp: vote.timestamp
      };
      
      // Add each vote option as a separate column
      Object.entries(vote.votes).forEach(([question, answer]) => {
        flatVote[question] = answer;
      });
      
      return flatVote;
    });
    
    // Get all possible fields (columns)
    const fields = Array.from(new Set(
      flattenedVotes.flatMap(vote => Object.keys(vote))
    ));
    
    // Add headers
    worksheet.columns = fields.map(field => ({
      header: field,
      key: field,
      width: 20
    }));
    
    // Add rows
    flattenedVotes.forEach(vote => {
      worksheet.addRow(vote);
    });
    
    // Format header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };
    
    // Set headers for file download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=votes.xlsx');
    
    // Generate Excel file and stream it to the client
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'An error occurred while exporting votes.' 
    });
  }
});

// API endpoint to change admin password
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Both current and new passwords are required' });
  }
  
  try {
    const admin = fs.readJsonSync(adminFile);
    
    if (!bcrypt.compareSync(currentPassword, admin.passwordHash)) {
      return res.json({ success: false, message: 'Current password is incorrect' });
    }
    
    // Update password
    admin.passwordHash = bcrypt.hashSync(newPassword, 10);
    fs.writeJsonSync(adminFile, admin);
    
    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Password change error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'An error occurred while changing the password.' 
    });
  }
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`Voter validation app listening at http://localhost:${port}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
});
