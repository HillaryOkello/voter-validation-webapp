# Voter Validation Web Application

A secure web application for voter validation built with Node.js and Express. This system allows organizations to validate voters' membership numbers against a register and prevent duplicate voting.

## Features

- Real-time membership number validation against a CSV or Excel voter register
- Secure voting form with multi-step validation
- Admin panel for uploading voter register and viewing statistics
- Prevention of duplicate voting by tracking used membership numbers
- CSV/Excel export of voting data
- Membership number lookup feature for voters
- Admin authentication with password change functionality
- Responsive design using Bootstrap

## Local Development

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Start the development server:
   ```
   npm start
   ```
4. Access the application at http://localhost:3000

## Default Admin Credentials

- Username: admin
- Password: admin123

**Important:** Change the default password immediately after first login.

## Deployment to Render

This application is configured for easy deployment to Render:

1. Sign up for a free account at [render.com](https://render.com)
2. Connect your GitHub/GitLab repository or upload your code
3. Create a new Web Service
4. Use the following settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Add the following environment variables:
     - NODE_ENV: production
     - SESSION_SECRET: [generate a secure random string]
5. Create and attach disk storage for the data and uploads directories
6. Deploy the application

## Data Storage

The application stores:
- Voter register in the `/uploads` directory
- Vote records and admin credentials in the `/data` directory

When deploying to Render, persistent disk storage is configured in the `render.yaml` file.
