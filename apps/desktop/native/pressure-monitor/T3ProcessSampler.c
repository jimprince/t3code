#include "T3ProcessSampler.h"

#include <libproc.h>
#include <mach/mach.h>
#include <stdlib.h>
#include <string.h>

int32_t t3_sample_processes(T3ProcessSample *samples, int32_t capacity) {
  if (samples == NULL || capacity <= 0) {
    return 0;
  }

  int bytes = proc_listallpids(NULL, 0);
  if (bytes <= 0) {
    return 0;
  }

  int pid_capacity = bytes / (int)sizeof(pid_t) + 64;
  pid_t *pids = calloc((size_t)pid_capacity, sizeof(pid_t));
  if (pids == NULL) {
    return 0;
  }

  int pid_bytes = proc_listallpids(pids, pid_capacity * (int)sizeof(pid_t));
  int pid_count = pid_bytes > 0 ? pid_bytes / (int)sizeof(pid_t) : 0;
  int32_t written = 0;

  for (int index = 0; index < pid_count && written < capacity; index += 1) {
    pid_t pid = pids[index];
    if (pid <= 0) {
      continue;
    }

    struct proc_bsdinfo bsd_info;
    int bsd_bytes = proc_pidinfo(
      pid,
      PROC_PIDTBSDINFO,
      0,
      &bsd_info,
      (int)sizeof(bsd_info)
    );
    if (bsd_bytes != (int)sizeof(bsd_info)) {
      continue;
    }

    struct rusage_info_v4 usage;
    memset(&usage, 0, sizeof(usage));
    uint64_t cpu_nanos = 0;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) == 0) {
      cpu_nanos = usage.ri_user_time + usage.ri_system_time;
    } else {
      struct proc_taskinfo task_info;
      int task_bytes = proc_pidinfo(
        pid,
        PROC_PIDTASKINFO,
        0,
        &task_info,
        (int)sizeof(task_info)
      );
      if (task_bytes != (int)sizeof(task_info)) {
        continue;
      }
      cpu_nanos = task_info.pti_total_user + task_info.pti_total_system;
    }

    T3ProcessSample *sample = &samples[written];
    memset(sample, 0, sizeof(*sample));
    sample->pid = pid;
    sample->uid = bsd_info.pbi_uid;
    sample->cpu_nanos = cpu_nanos;
    if (proc_name(pid, sample->name, (uint32_t)sizeof(sample->name)) <= 0) {
      strncpy(sample->name, bsd_info.pbi_name, sizeof(sample->name) - 1);
    }
    written += 1;
  }

  free(pids);
  return written;
}

int32_t t3_sample_host_cpu(T3HostCpuSample *sample) {
  if (sample == NULL) {
    return 0;
  }

  host_cpu_load_info_data_t cpu;
  mach_msg_type_number_t count = HOST_CPU_LOAD_INFO_COUNT;
  kern_return_t result = host_statistics(
    mach_host_self(),
    HOST_CPU_LOAD_INFO,
    (host_info_t)&cpu,
    &count
  );
  if (result != KERN_SUCCESS) {
    return 0;
  }

  sample->user = cpu.cpu_ticks[CPU_STATE_USER];
  sample->system = cpu.cpu_ticks[CPU_STATE_SYSTEM];
  sample->idle = cpu.cpu_ticks[CPU_STATE_IDLE];
  sample->nice = cpu.cpu_ticks[CPU_STATE_NICE];
  return 1;
}
