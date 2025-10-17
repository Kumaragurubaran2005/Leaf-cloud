create table files (customer_id number NOT NULL,customername varchar2(20) NOT NULL,code BLOB NOT NULL,dataset BLOB,requirement BLOB,num_workers NUMBER NOT NULL);
 

select * from FILES;

drop table files;


CREATE TABLE Storage (customername VARCHAR(20),code BLOB,dataset BLOB,requirement BLOB);
