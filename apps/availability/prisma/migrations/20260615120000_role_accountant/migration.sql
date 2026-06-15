-- Add ACCOUNTANT role (freelance finance/bookkeeping access)
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACCOUNTANT';
