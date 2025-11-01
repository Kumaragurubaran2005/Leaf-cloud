create table files (customer_id VARCHAR(30) NOT NULL,customername varchar2(20) NOT NULL,code BLOB NOT NULL,dataset BLOB,requirement BLOB,num_workers NUMBER NOT NULL);
 

select * from users where username='Kumar' and PASSWORD='2005';

drop table users;


CREATE TABLE Storage (customername VARCHAR(20),code BLOB,dataset BLOB,requirement BLOB);

CREATE TABLE users (username VARCHAR(20) not NULL,password VARCHAR(20) not NULL,feild varchar(20) not null check(feild in ('client','resource_provider')));



INSERT INTO users
VALUES ('Kumar', '2005','client');
commit;
SELECT * FROM users WHERE username='kumar' and password='2005';

create table resource_provider (workerId varchar(20),taskCompleted number,taskPending NUMBER,taskFailed NUMBER,taskRunning NUMBER);

SELECT * from RESOURCE_PROVIDER;