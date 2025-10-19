create table files (customer_id VARCHAR(30) NOT NULL,customername varchar2(20) NOT NULL,code BLOB NOT NULL,dataset BLOB,requirement BLOB,num_workers NUMBER NOT NULL);
 

select * from FILES;

drop table files;


CREATE TABLE Storage (customername VARCHAR(20),code BLOB,dataset BLOB,requirement BLOB);

CREATE TABLE users (username VARCHAR(20) not NULL,password VARCHAR(20) not NULL);



INSERT INTO users (username, password) 
VALUES ('kumar', '2005');
commit;
SELECT * FROM users WHERE username='kumar' and password='2005';

