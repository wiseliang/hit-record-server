CREATE TABLE IF NOT EXISTS credentials (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  openid VARCHAR(128) NOT NULL UNIQUE,
  student_id TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_uuid VARCHAR(64) NOT NULL UNIQUE,
  openid VARCHAR(128) NOT NULL,
  type VARCHAR(32) NOT NULL,
  week INT NOT NULL DEFAULT 0,
  options JSON,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  total INT NOT NULL DEFAULT 0,
  processed INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  current_student TEXT,
  errors JSON,
  started_at DATETIME,
  completed_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX user_history (openid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS weekly_summary (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  openid VARCHAR(128) NOT NULL,
  semester_start_date DATE NOT NULL,
  week INT NOT NULL,
  type VARCHAR(32) NOT NULL,
  total INT NOT NULL DEFAULT 0,
  success INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  task_uuid VARCHAR(64) NOT NULL,
  UNIQUE KEY semester_week (openid, semester_start_date, week, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS grade_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_uuid VARCHAR(64) NOT NULL UNIQUE,
  openid VARCHAR(128) NOT NULL,
  year VARCHAR(8), school VARCHAR(128), major VARCHAR(128), class_name VARCHAR(64),
  extract_courses BOOLEAN DEFAULT TRUE,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  student_count INT DEFAULT 0, course_progress INT DEFAULT 0,
  avg_gpa DECIMAL(6,3), total_failed INT DEFAULT 0,
  current_phase TEXT, results JSON,
  started_at DATETIME, completed_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX user_history (openid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
