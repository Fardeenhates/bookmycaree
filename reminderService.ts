export interface User {
  id: number;
  name: string;
  email: string;
  phone: string;
  role: 'admin' | 'doctor' | 'patient';
  age?: number;
  doctorId?: number;
  patientId?: number;
}

export interface Doctor {
  id: number;
  user_id: number;
  name: string;
  email: string;
  phone: string;
  specialization: string;
  degree: string;
  qualification: string;
  bio: string;
  experience: number;
  consultation_fee: number;
  availability: string;
}

export interface Appointment {
  id: number;
  patient_id: number;
  doctor_id: number;
  date: string;
  time: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'cancelled';
  notes: string;
  doctor_name?: string;
  patient_name?: string;
  specialization?: string;
  consultation_fee?: number;
  payment_status?: 'pending' | 'completed' | 'failed' | null;
}

export interface AdminStats {
  totalPatients: number;
  totalDoctors: number;
  totalAppointments: number;
  revenue: number;
}
