import time
from multiprocessing import Pool, cpu_count

# ---------------------------
# CPU-intensive function
# ---------------------------
def fib(n):
    if n <= 1:
        return n
    return fib(n-1) + fib(n-2)

# ---------------------------
# Worker for multiprocessing
# ---------------------------
def worker(n):
    result = fib(n)
    print(f"Fib({n}) = {result}")
    return result

if __name__ == "__main__":
    numbers = [35, 36, 37, 38]  # Higher numbers increase CPU load

    start_time = time.time()
    
    # Use all CPU cores
    with Pool(cpu_count()) as pool:
        pool.map(worker, numbers)

    end_time = time.time()
    print(f"Total time: {end_time - start_time:.2f} seconds")
