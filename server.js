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
    secure: process.env.NODE_ENV === 'production', 
    maxAge: 3600000 // 1 hour
  }
}));

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

// Ensure directories exist
fs.ensureDirSync(path.join(__dirname, 'uploads'));
fs.ensureDirSync(path.join(__dirname, 'data'));
fs.ensureDirSync(path.join(__dirname, 'public'));

// Store for votes and admin credentials
const votesFile = path.join(__dirname, 'data', 'votes.json');
const adminFile = path.join(__dirname, 'data', 'admin.json');

// Initialize files if they don't exist
if (!fs.existsSync(votesFile)) {
  fs.writeJsonSync(votesFile, []);
}

if (!fs.existsSync(adminFile)) {
  // Create default admin credentials (username: admin, password: admin123)
  const defaultAdmin = {
    username: 'admin',
    // Hash the password
    passwordHash: bcrypt.hashSync('admin123', 10)
  };
  fs.writeJsonSync(adminFile, defaultAdmin);
}

// Function to check if a file exists
function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

// Function to get the voter register file path
function getVoterRegisterPath() {
  const baseDir = path.join(__dirname, 'uploads');
  const csvPath = path.join(baseDir, 'voter_register.csv');
  const xlsxPath = path.join(baseDir, 'voter_register.xlsx');
  const xlsPath = path.join(baseDir, 'voter_register.xls');
  
  if (fileExists(xlsxPath)) return xlsxPath;
  if (fileExists(xlsPath)) return xlsPath;
  if (fileExists(csvPath)) return csvPath;
  
  return null;
}

// Function to read voter register
async function getVoterRegister() {
  const registerPath = getVoterRegisterPath();
  if (!registerPath) {
    return [];
  }
  
  const fileExt = path.extname(registerPath).toLowerCase();
  
  if (fileExt === '.csv') {
    // CSV processing
    return new Promise((resolve, reject) => {
      const results = [];
      fs.createReadStream(registerPath)
        .pipe(csvParser())
        .on('data', (data) => results.push(data))
        .on('end', () => resolve(results))
        .on('error', (error) => reject(error));
    });
  } else if (fileExt === '.xlsx' || fileExt === '.xls') {
    // Excel processing
    try {
      const workbook = XLSX.readFile(registerPath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);
      return data;
    } catch (error) {
      console.error('Error reading Excel file:', error);
      throw error;
    }
  } else {
    throw new Error('Unsupported file format');
  }
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
    const admin = fs.readJsonSync(adminFile);
    
    if (username === admin.username && bcrypt.compareSync(password, admin.passwordHash)) {
      req.session.isAuthenticated = true;
      return res.redirect('/admin');
    }
    
    res.render('login', { error: 'Invalid username or password' });
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { error: 'An error occurred during login' });
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

app.get('/forgot-membership', (req, res) => {
  res.render('forgot-membership');
});

// API endpoint to validate membership number
app.post('/api/validate-membership', async (req, res) => {
  const { membershipNumber } = req.body;
  
  if (!membershipNumber) {
    return res.status(400).json({ valid: false, message: 'Membership number is required' });
  }
  
  try {
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
  const { membershipNumber, email, votes } = req.body;
  
  if (!membershipNumber || !email || !votes) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
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
        if (!voteCounts[question]) {
          voteCounts[question] = {};
        }
        
        if (!voteCounts[question][answer]) {
          voteCounts[question][answer] = 0;
        }
        
        voteCounts[question][answer]++;
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
