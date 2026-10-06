#ifndef T3_PROCESS_SAMPLER_H
#define T3_PROCESS_SAMPLER_H

#include <stdint.h>
#include <sys/types.h>

#define T3_PROCESS_NAME_MAX 256

typedef struct {
  int32_t pid;
  uint32_t uid;
  uint64_t cpu_nanos;
  char name[T3_PROCESS_NAME_MAX];
} T3ProcessSample;

typedef struct {
  uint64_t user;
  uint64_t system;
  uint64_t idle;
  uint64_t nice;
} T3HostCpuSample;

int32_t t3_sample_processes(T3ProcessSample *samples, int32_t capacity);
int32_t t3_sample_host_cpu(T3HostCpuSample *sample);

#endif
