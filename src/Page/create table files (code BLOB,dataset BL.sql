create table files (customer_id VARCHAR(30) NOT NULL,customername varchar2(20) NOT NULL,code BLOB NOT NULL,dataset BLOB,requirement BLOB,num_workers NUMBER NOT NULL);
 

select * from files ;

drop table files;




CREATE TABLE users (username VARCHAR(20) not NULL,password VARCHAR(20) not NULL,feild varchar(20) not null check(feild in ('client','resource_provider')));



INSERT INTO users
VALUES ('kumar', '2005','resource_provider');
commit;
SELECT * FROM users WHERE username='kumar' and password='2005';

create table resource_provider (workerId varchar(20),taskCompleted number,taskPending NUMBER,taskFailed NUMBER,taskRunning NUMBER);

SELECT * from RESOURCE_PROVIDER;

CREATE TABLE worker_usage_stats (
    usage_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id VARCHAR2(100) NOT NULL,
    customer_id VARCHAR2(100) NOT NULL,
    task_id VARCHAR2(100) NOT NULL,
    cpu_usage NUMBER(5,2),
    memory_usage NUMBER(8,2),
    execution_time NUMBER(8,2),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    raw_usage_data CLOB
);

CREATE INDEX idx_worker_usage_worker_id ON worker_usage_stats(worker_id);
CREATE INDEX idx_worker_usage_timestamp ON worker_usage_stats(timestamp);
CREATE INDEX idx_worker_usage_task_id ON worker_usage_stats(task_id);


CREATE TABLE files (
    customer_id      VARCHAR2(100) PRIMARY KEY,
    customername     VARCHAR2(100),
    code             BLOB,
    dataset          BLOB,
    requirement      BLOB,
    num_workers      NUMBER,
    code_filename    VARCHAR2(255),        -- NEW: Stores original code filename
    dataset_filename VARCHAR2(255),        -- NEW: Stores original dataset filename  
    requirement_filename VARCHAR2(255),    -- NEW: Stores original requirement filename
    created_date     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);