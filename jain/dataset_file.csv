def getter(bust_time,no_of_processes):
    waiting_time=[0]*no_of_processes
    trt=[0]*no_of_processes
    for i in range(no_of_processes):
        if i==0:
            waiting_time[i]=0
        else:
            waiting_time[i]=waiting_time[i-1]+bust_time[i-1]
        trt[i]=waiting_time[i]+bust_time[i]
    print("process\tburst time\twaiting_time\ttrt")
    for i in range(no_of_processes):
         print(f"{i}\t{bust_time[i]}\t\t{waiting_time[i]}\t\t{trt[i]}")

if __name__=="__main__":
    getter([5,8,12],3)