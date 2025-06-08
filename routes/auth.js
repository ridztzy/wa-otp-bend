const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { nama, email, password } = req.body;
    
    // Tambah validasi input
    if (!nama || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Nama, email, dan password harus diisi'
      });
    }

    // Debug: cek data yang diterima
    console.log('Data registrasi:', { nama, email, password });

    // Cek user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email sudah terdaftar'
      });
    }

    // Create user dengan data lengkap
    const user = await User.create({
      nama: nama,
      email: email,
      password: password
    });

    res.status(201).json({
      success: true,
      message: 'Registrasi berhasil',
      data: {
        id: user._id,
        nama: user.nama,
        email: user.email
      }
    });

  } catch (error) {
    console.error('Error detail:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal melakukan registrasi',
      error: error.message
    });
  }
});

// POST /auth/login 
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Debug: cek data login yang diterima
    console.log('Login attempt:', { email });

    // Cari user berdasarkan email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ 
        success: false,
        message: 'Email atau password salah'  // Ubah format error message
      });
    }

    // Verifikasi password
    const isValid = await user.checkPassword(password);
    if (!isValid) {
      return res.status(401).json({ 
        success: false,
        message: 'Email atau password salah'  // Ubah format error message
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user._id,
        email: user.email,
        role: user.role 
      }, 
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Response dengan format yang sesuai NextAuth
    res.json({
      success: true,
      message: 'Login berhasil',
      data: {
        user: {
          id: user._id,
          name: user.nama,    // Sesuaikan dengan NextAuth
          email: user.email,
          role: user.role
        },
        token
      }
    });

  } catch (error) {
    console.error('Error login:', error);
    res.status(500).json({ 
      success: false,
      message: 'Gagal melakukan login'  // Ubah format error message
    });
  }
});

module.exports = router;