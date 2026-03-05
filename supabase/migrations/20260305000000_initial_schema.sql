-- ============================================================================
-- OCF Fellowship Management System - Initial Schema
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Students Table
-- Stores information about fellowship-eligible students
-- ============================================================================
CREATE TABLE public.students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fgcu_id VARCHAR(20) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20),
    major VARCHAR(100),
    gpa DECIMAL(3, 2),
    expected_graduation DATE,
    academic_standing VARCHAR(50) DEFAULT 'Good Standing',
    enrollment_status VARCHAR(50) DEFAULT 'Full-time',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX idx_students_email ON public.students(email);
CREATE INDEX idx_students_fgcu_id ON public.students(fgcu_id);

-- ============================================================================
-- Fellowships Table
-- Stores information about available fellowship opportunities
-- ============================================================================
CREATE TABLE public.fellowships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    funding_amount DECIMAL(10, 2),
    duration_months INTEGER,
    eligibility_criteria TEXT,
    application_deadline DATE NOT NULL,
    start_date DATE,
    end_date DATE,
    max_recipients INTEGER DEFAULT 1,
    status VARCHAR(50) DEFAULT 'Open' CHECK (status IN ('Draft', 'Open', 'Closed', 'Awarded')),
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for filtering by status and deadline
CREATE INDEX idx_fellowships_status ON public.fellowships(status);
CREATE INDEX idx_fellowships_deadline ON public.fellowships(application_deadline);

-- ============================================================================
-- Applications Table
-- Stores student fellowship applications
-- ============================================================================
CREATE TABLE public.applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    fellowship_id UUID NOT NULL REFERENCES public.fellowships(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'Submitted' CHECK (status IN ('Draft', 'Submitted', 'Under Review', 'Interviewed', 'Accepted', 'Rejected', 'Withdrawn')),
    submitted_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID,
    essay TEXT,
    cv_url TEXT,
    recommendation_letters TEXT[], -- Array of URLs or file paths
    notes TEXT,
    score DECIMAL(5, 2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(student_id, fellowship_id)
);

-- Indexes for querying applications
CREATE INDEX idx_applications_student ON public.applications(student_id);
CREATE INDEX idx_applications_fellowship ON public.applications(fellowship_id);
CREATE INDEX idx_applications_status ON public.applications(status);

-- ============================================================================
-- Advising Sessions Table
-- Tracks advising sessions with students
-- ============================================================================
CREATE TABLE public.advising_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    advisor_id UUID,
    session_date TIMESTAMPTZ NOT NULL,
    duration_minutes INTEGER DEFAULT 30,
    session_type VARCHAR(50) DEFAULT 'General' CHECK (session_type IN ('General', 'Fellowship', 'Academic', 'Career')),
    notes TEXT,
    follow_up_required BOOLEAN DEFAULT FALSE,
    follow_up_notes TEXT,
    status VARCHAR(50) DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'Completed', 'Cancelled', 'No-Show')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for scheduling and querying
CREATE INDEX idx_advising_student ON public.advising_sessions(student_id);
CREATE INDEX idx_advising_date ON public.advising_sessions(session_date);
CREATE INDEX idx_advising_status ON public.advising_sessions(status);

-- ============================================================================
-- Application Reviews Table
-- Tracks individual review comments and scores for applications
-- ============================================================================
CREATE TABLE public.application_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL,
    score DECIMAL(5, 2),
    comments TEXT,
    criteria_scores JSONB, -- Stores individual criterion scores
    review_date TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reviews_application ON public.application_reviews(application_id);

-- ============================================================================
-- Users Table (for staff/administrators)
-- Stores information about system users (advisors, reviewers, admins)
-- ============================================================================
CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role VARCHAR(50) DEFAULT 'Advisor' CHECK (role IN ('Admin', 'Advisor', 'Reviewer', 'Staff')),
    department VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON public.users(email);
CREATE INDEX idx_users_role ON public.users(role);

-- ============================================================================
-- Update Timestamp Trigger Function
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply the trigger to all tables with updated_at
CREATE TRIGGER update_students_updated_at BEFORE UPDATE ON public.students
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_fellowships_updated_at BEFORE UPDATE ON public.fellowships
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_applications_updated_at BEFORE UPDATE ON public.applications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_advising_sessions_updated_at BEFORE UPDATE ON public.advising_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_application_reviews_updated_at BEFORE UPDATE ON public.application_reviews
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Row Level Security (RLS) Policies
-- Enable RLS on all tables (requires configuration with Supabase Auth)
-- ============================================================================
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fellowships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advising_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.application_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Example policies (customize based on your auth requirements)
-- Students can view their own records
CREATE POLICY "Students can view own record" ON public.students
    FOR SELECT USING (auth.email() = email);

-- All authenticated users can view fellowships
CREATE POLICY "Authenticated users can view fellowships" ON public.fellowships
    FOR SELECT USING (auth.role() = 'authenticated');

-- Students can view their own applications
CREATE POLICY "Students can view own applications" ON public.applications
    FOR SELECT USING (
        student_id IN (SELECT id FROM public.students WHERE email = auth.email())
    );

-- ============================================================================
-- Sample Data Functions
-- ============================================================================
COMMENT ON TABLE public.students IS 'Fellowship-eligible students';
COMMENT ON TABLE public.fellowships IS 'Available fellowship opportunities';
COMMENT ON TABLE public.applications IS 'Student fellowship applications';
COMMENT ON TABLE public.advising_sessions IS 'Advising session records';
COMMENT ON TABLE public.application_reviews IS 'Application review records';
COMMENT ON TABLE public.users IS 'System users (staff, advisors, admins)';
