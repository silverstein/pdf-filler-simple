#if !defined(__APPLE__) || !defined(__MACH__)
#error "docling-macos-supervisor requires Darwin"
#endif

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

enum {
  MAX_PIDS = 4096,
  MAX_IDENTITIES = 8192,
  MAX_ENVIRONMENT = 128,
  MAX_ENVIRONMENT_BYTES = 65536,
  MAX_JSON_BYTES = 16384,
  DRAIN_BUDGET_BYTES = 262144,
  CONTROL_MAGIC = 0x50444653,
  CONTROL_READY = 1,
  CONTROL_EXEC_FAILED = 2,
  CHILD_STAGE_NONE = 0,
  CHILD_STAGE_SETSID = 1,
  CHILD_STAGE_STDIO = 2,
  CHILD_STAGE_RLIMIT_CORE = 3,
  CHILD_STAGE_RLIMIT_CPU = 4,
  CHILD_STAGE_RLIMIT_FSIZE = 5,
  CHILD_STAGE_RLIMIT_NOFILE = 6,
  CHILD_STAGE_RLIMIT_AS = 7,
  CHILD_STAGE_READY_WRITE = 8,
  CHILD_STAGE_GATE = 9,
  CHILD_STAGE_EXEC = 10,
};

typedef struct {
  uint64_t deadline_ms;
  uint64_t leader_exit_grace_ms;
  uint64_t sample_ms;
  uint64_t stdout_max_bytes;
  uint64_t stderr_max_bytes;
  uint64_t physical_footprint_max_bytes;
  uint64_t address_space_bytes;
  uint64_t cpu_seconds;
  uint64_t file_size_bytes;
  uint64_t nofile;
  int evidence_fd;
  int lease_fd;
  char **environment;
  size_t environment_count;
  char **command;
} run_config;

typedef struct {
  uint32_t magic;
  uint32_t type;
  int32_t error_number;
  int32_t reserved;
  pid_t pid;
  pid_t pgid;
  uint64_t core_bytes;
  uint64_t cpu_seconds;
  uint64_t file_size_bytes;
  uint64_t nofile;
  uint64_t address_space_bytes;
} control_message;

typedef struct {
  unsigned char *bytes;
  size_t length;
  size_t capacity;
  uint64_t observed_bytes;
  uint64_t limit;
  bool exceeded;
} bounded_buffer;

typedef struct {
  pid_t pid;
  uint64_t start_abstime;
  bool escaped;
} process_identity;

typedef struct {
  process_identity identities[MAX_IDENTITIES];
  size_t identity_count;
  pid_t escaped_pids[MAX_PIDS];
  size_t escaped_count;
  uint64_t sample_count;
  uint64_t sample_race_count;
  uint64_t max_group_members;
  uint64_t max_group_physical_footprint;
  uint64_t max_group_rss;
  uint64_t max_group_virtual;
  uint64_t max_group_cpu_ns;
  bool escaped_session_detected;
} observations;

typedef enum {
  FAILURE_NONE = 0,
  FAILURE_CONFIGURATION,
  FAILURE_CHILD_SETUP,
  FAILURE_EXEC,
  FAILURE_DEADLINE,
  FAILURE_STDOUT_LIMIT,
  FAILURE_STDERR_LIMIT,
  FAILURE_PHYSICAL_FOOTPRINT,
  FAILURE_ENUMERATION,
  FAILURE_PID_REUSE,
  FAILURE_ESCAPED_SESSION,
  FAILURE_LIVE_DESCENDANTS,
  FAILURE_LEADER_EXIT,
  FAILURE_CLEANUP,
  FAILURE_LEASE,
  FAILURE_INTERNAL,
} failure_code;

typedef struct {
  failure_code code;
  int error_number;
} first_failure;

static volatile sig_atomic_t active_pgid = -1;
static volatile sig_atomic_t active_leader = -1;

static void emergency_terminate(int signal_number) {
  (void)signal_number;
  if (active_pgid > 0 && active_leader > 0) {
    (void)kill(-active_pgid, SIGSTOP);
    (void)kill(-active_pgid, SIGKILL);
  }
  if (active_leader > 0) {
    (void)kill(active_leader, SIGKILL);
  }
  _exit(128 + SIGTERM);
}

static void install_signal_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = emergency_terminate;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  (void)sigaction(SIGINT, &action, NULL);
  (void)sigaction(SIGTERM, &action, NULL);
  (void)sigaction(SIGHUP, &action, NULL);
  signal(SIGPIPE, SIG_IGN);
}

static void usage(void) {
  const char *message =
      "usage:\n"
      "  docling-macos-supervisor run"
      " --deadline-ms N --leader-exit-grace-ms N --sample-ms N"
      " --stdout-max-bytes N --stderr-max-bytes N"
      " --physical-footprint-max-bytes N"
      " --rlimit-as-bytes N --rlimit-cpu-seconds N"
      " --rlimit-fsize-bytes N --rlimit-nofile N"
      " --evidence-fd N --lease-fd N [--env KEY=VALUE]..."
      " -- COMMAND [ARG ...]\n"
      "  docling-macos-supervisor cleanup"
      " --pgid N --leader-pid N --leader-start-abstime N"
      " --evidence-fd N\n";
  (void)write(STDERR_FILENO, message, strlen(message));
}

static bool parse_u64(const char *text, uint64_t minimum, uint64_t maximum,
                      uint64_t *result) {
  if (text == NULL || *text == '\0' || *text == '-' || *text == '+') {
    return false;
  }
  errno = 0;
  char *end = NULL;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < minimum ||
      value > maximum) {
    return false;
  }
  *result = (uint64_t)value;
  return true;
}

static bool parse_fd(const char *text, int *result) {
  uint64_t value = 0;
  if (!parse_u64(text, 3, 1024, &value)) {
    return false;
  }
  *result = (int)value;
  return true;
}

static bool next_value(int argc, char **argv, int *index, const char **value) {
  if (*index + 1 >= argc) {
    return false;
  }
  *index += 1;
  *value = argv[*index];
  return true;
}

static bool append_environment(run_config *config, char *value,
                               size_t *environment_bytes) {
  size_t length = strlen(value);
  char *separator = strchr(value, '=');
  if (separator == NULL || separator == value || length > 4096 ||
      config->environment_count >= MAX_ENVIRONMENT ||
      *environment_bytes > MAX_ENVIRONMENT_BYTES - length - 1) {
    return false;
  }
  size_t key_length = (size_t)(separator - value);
  for (size_t index = 0; index < config->environment_count; index += 1) {
    const char *existing = config->environment[index];
    const char *existing_separator = strchr(existing, '=');
    if (existing_separator != NULL &&
        (size_t)(existing_separator - existing) == key_length &&
        memcmp(existing, value, key_length) == 0) {
      return false;
    }
  }
  config->environment[config->environment_count++] = value;
  config->environment[config->environment_count] = NULL;
  *environment_bytes += length + 1;
  return true;
}

static bool parse_run_config(int argc, char **argv, run_config *config) {
  memset(config, 0, sizeof(*config));
  config->environment =
      calloc((size_t)MAX_ENVIRONMENT + 1, sizeof(char *));
  if (config->environment == NULL) {
    return false;
  }
  config->evidence_fd = -1;
  config->lease_fd = -1;
  bool seen_deadline = false;
  bool seen_leader_exit_grace = false;
  bool seen_sample = false;
  bool seen_stdout = false;
  bool seen_stderr = false;
  bool seen_footprint = false;
  bool seen_as = false;
  bool seen_cpu = false;
  bool seen_fsize = false;
  bool seen_nofile = false;
  bool seen_evidence = false;
  bool seen_lease = false;
  size_t environment_bytes = 0;

  for (int index = 2; index < argc; index += 1) {
    if (strcmp(argv[index], "--") == 0) {
      if (index + 1 >= argc) {
        return false;
      }
      config->command = &argv[index + 1];
      break;
    }
    const char *value = NULL;
    if (!next_value(argc, argv, &index, &value)) {
      return false;
    }
    if (strcmp(argv[index - 1], "--deadline-ms") == 0 && !seen_deadline) {
      seen_deadline =
          parse_u64(value, 1, 600000, &config->deadline_ms);
      if (!seen_deadline) return false;
    } else if (strcmp(argv[index - 1], "--leader-exit-grace-ms") == 0 &&
               !seen_leader_exit_grace) {
      seen_leader_exit_grace =
          parse_u64(value, 0, 5000, &config->leader_exit_grace_ms);
      if (!seen_leader_exit_grace) return false;
    } else if (strcmp(argv[index - 1], "--sample-ms") == 0 && !seen_sample) {
      seen_sample = parse_u64(value, 1, 1000, &config->sample_ms);
      if (!seen_sample) return false;
    } else if (strcmp(argv[index - 1], "--stdout-max-bytes") == 0 &&
               !seen_stdout) {
      seen_stdout =
          parse_u64(value, 1, 16777216, &config->stdout_max_bytes);
      if (!seen_stdout) return false;
    } else if (strcmp(argv[index - 1], "--stderr-max-bytes") == 0 &&
               !seen_stderr) {
      seen_stderr =
          parse_u64(value, 1, 16777216, &config->stderr_max_bytes);
      if (!seen_stderr) return false;
    } else if (strcmp(argv[index - 1],
                      "--physical-footprint-max-bytes") == 0 &&
               !seen_footprint) {
      seen_footprint = parse_u64(value, 16777216, UINT64_C(549755813888),
                                 &config->physical_footprint_max_bytes);
      if (!seen_footprint) return false;
    } else if (strcmp(argv[index - 1], "--rlimit-as-bytes") == 0 &&
               !seen_as) {
      seen_as = parse_u64(value, 1073741824, UINT64_C(1099511627776),
                          &config->address_space_bytes);
      if (!seen_as) return false;
    } else if (strcmp(argv[index - 1], "--rlimit-cpu-seconds") == 0 &&
               !seen_cpu) {
      seen_cpu = parse_u64(value, 1, 3600, &config->cpu_seconds);
      if (!seen_cpu) return false;
    } else if (strcmp(argv[index - 1], "--rlimit-fsize-bytes") == 0 &&
               !seen_fsize) {
      seen_fsize = parse_u64(value, 1048576, 1073741824,
                             &config->file_size_bytes);
      if (!seen_fsize) return false;
    } else if (strcmp(argv[index - 1], "--rlimit-nofile") == 0 &&
               !seen_nofile) {
      seen_nofile = parse_u64(value, 32, 4096, &config->nofile);
      if (!seen_nofile) return false;
    } else if (strcmp(argv[index - 1], "--evidence-fd") == 0 &&
               !seen_evidence) {
      seen_evidence = parse_fd(value, &config->evidence_fd);
      if (!seen_evidence) return false;
    } else if (strcmp(argv[index - 1], "--lease-fd") == 0 && !seen_lease) {
      seen_lease = parse_fd(value, &config->lease_fd);
      if (!seen_lease) return false;
    } else if (strcmp(argv[index - 1], "--env") == 0) {
      if (!append_environment(config, (char *)value, &environment_bytes)) {
        return false;
      }
    } else {
      return false;
    }
  }

  return seen_deadline && seen_leader_exit_grace && seen_sample &&
         seen_stdout && seen_stderr &&
         seen_footprint && seen_as && seen_cpu && seen_fsize && seen_nofile &&
         seen_evidence && seen_lease && config->command != NULL &&
         config->evidence_fd != config->lease_fd;
}

static uint64_t saturating_add(uint64_t left, uint64_t right) {
  return UINT64_MAX - left < right ? UINT64_MAX : left + right;
}

static bool set_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  return flags >= 0 && fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0 &&
         (fcntl(fd, F_GETFD) & FD_CLOEXEC) != 0;
}

static bool set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static bool valid_parent_fd(int fd) {
  struct stat metadata;
  return fd >= 3 && fstat(fd, &metadata) == 0 && set_cloexec(fd);
}

static bool write_all(int fd, const void *bytes, size_t length) {
  const unsigned char *cursor = bytes;
  while (length > 0) {
    ssize_t written = write(fd, cursor, length);
    if (written > 0) {
      cursor += (size_t)written;
      length -= (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

static bool read_exact(int fd, void *bytes, size_t length) {
  unsigned char *cursor = bytes;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count > 0) {
      cursor += (size_t)count;
      length -= (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

static uint64_t continuous_now(void) {
  uint64_t value = mach_continuous_time();
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
  const char *fault = getenv("PDF_TOOLS_SUPERVISOR_FAULT");
  if (fault != NULL && strcmp(fault, "continuous_clock_jump") == 0) {
    static unsigned calls = 0;
    calls += 1;
    if (calls > 2) {
      mach_timebase_info_data_t timebase;
      if (mach_timebase_info(&timebase) == KERN_SUCCESS &&
          timebase.numer != 0) {
        uint64_t jump =
            (UINT64_C(3600) * UINT64_C(1000000000) * timebase.denom) /
            timebase.numer;
        value = saturating_add(value, jump);
      }
    }
  }
#endif
  return value;
}

static uint64_t ticks_to_ns(uint64_t ticks) {
  static mach_timebase_info_data_t timebase = {0, 0};
  if (timebase.denom == 0 &&
      mach_timebase_info(&timebase) != KERN_SUCCESS) {
    return UINT64_MAX;
  }
  __uint128_t scaled = (__uint128_t)ticks * timebase.numer;
  scaled /= timebase.denom;
  return scaled > UINT64_MAX ? UINT64_MAX : (uint64_t)scaled;
}

static uint64_t elapsed_ns(uint64_t start, uint64_t now) {
  if (now < start) {
    return UINT64_MAX;
  }
  return ticks_to_ns(now - start);
}

static void set_failure(first_failure *failure, failure_code code,
                        int error_number) {
  if (failure->code == FAILURE_NONE) {
    failure->code = code;
    failure->error_number = error_number;
  }
}

static const char *failure_name(failure_code code) {
  switch (code) {
    case FAILURE_NONE:
      return "none";
    case FAILURE_CONFIGURATION:
      return "configuration";
    case FAILURE_CHILD_SETUP:
      return "child_setup";
    case FAILURE_EXEC:
      return "exec";
    case FAILURE_DEADLINE:
      return "deadline";
    case FAILURE_STDOUT_LIMIT:
      return "stdout_limit";
    case FAILURE_STDERR_LIMIT:
      return "stderr_limit";
    case FAILURE_PHYSICAL_FOOTPRINT:
      return "physical_footprint_limit";
    case FAILURE_ENUMERATION:
      return "enumeration";
    case FAILURE_PID_REUSE:
      return "pid_reuse";
    case FAILURE_ESCAPED_SESSION:
      return "escaped_session";
    case FAILURE_LIVE_DESCENDANTS:
      return "live_descendants";
    case FAILURE_LEADER_EXIT:
      return "leader_exit";
    case FAILURE_CLEANUP:
      return "cleanup";
    case FAILURE_LEASE:
      return "lease";
    case FAILURE_INTERNAL:
      return "internal";
  }
  return "internal";
}

static bool buffer_reserve(bounded_buffer *buffer, size_t required) {
  if (required <= buffer->capacity) {
    return true;
  }
  size_t next = buffer->capacity == 0 ? 4096 : buffer->capacity;
  while (next < required) {
    if (next > SIZE_MAX / 2) {
      return false;
    }
    next *= 2;
  }
  if ((uint64_t)next > buffer->limit) {
    next = (size_t)buffer->limit;
  }
  unsigned char *replacement = realloc(buffer->bytes, next);
  if (replacement == NULL) {
    return false;
  }
  buffer->bytes = replacement;
  buffer->capacity = next;
  return true;
}

static bool buffer_append(bounded_buffer *buffer, const unsigned char *bytes,
                          size_t length) {
  buffer->observed_bytes =
      saturating_add(buffer->observed_bytes, (uint64_t)length);
  size_t available =
      buffer->length >= buffer->limit
          ? 0
          : (size_t)(buffer->limit - (uint64_t)buffer->length);
  size_t retained = length < available ? length : available;
  if (retained > 0 &&
      (!buffer_reserve(buffer, buffer->length + retained) ||
       buffer->capacity < buffer->length + retained)) {
    return false;
  }
  if (retained > 0) {
    memcpy(buffer->bytes + buffer->length, bytes, retained);
    buffer->length += retained;
  }
  if ((uint64_t)length > (uint64_t)retained) {
    buffer->exceeded = true;
  }
  return true;
}

static bool drain_fd(int fd, bounded_buffer *buffer, bool *eof) {
  unsigned char scratch[65536];
  size_t drained = 0;
  for (;;) {
    ssize_t count = read(fd, scratch, sizeof(scratch));
    if (count > 0) {
      if (!buffer_append(buffer, scratch, (size_t)count)) {
        return false;
      }
      drained += (size_t)count;
      if (drained >= DRAIN_BUDGET_BYTES || buffer->exceeded) {
        return true;
      }
      continue;
    }
    if (count == 0) {
      *eof = true;
      return true;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return true;
    }
    return false;
  }
}

static bool install_limit(int resource, uint64_t value) {
  struct rlimit requested = {
      .rlim_cur = (rlim_t)value,
      .rlim_max = (rlim_t)value,
  };
  struct rlimit observed;
  return setrlimit(resource, &requested) == 0 &&
         getrlimit(resource, &observed) == 0 &&
         observed.rlim_cur == requested.rlim_cur &&
         observed.rlim_max == requested.rlim_max;
}

static void child_main(const run_config *config, int stdout_write,
                       int stderr_write, int control_write, int gate_read,
                       int stdout_read, int stderr_read, int control_read,
                       int gate_write) {
  (void)close(stdout_read);
  (void)close(stderr_read);
  (void)close(control_read);
  (void)close(gate_write);
  (void)close(config->evidence_fd);
  (void)close(config->lease_fd);

  control_message message;
  memset(&message, 0, sizeof(message));
  message.magic = CONTROL_MAGIC;
  message.type = CONTROL_READY;
  message.pid = getpid();

  if (setsid() < 0) {
    message.error_number = errno;
    message.reserved = CHILD_STAGE_SETSID;
    (void)write_all(control_write, &message, sizeof(message));
    _exit(120);
  }
  message.pgid = getpgrp();

  if (dup2(stdout_write, STDOUT_FILENO) < 0 ||
      dup2(stderr_write, STDERR_FILENO) < 0) {
    message.error_number = errno;
    message.reserved = CHILD_STAGE_STDIO;
    (void)write_all(control_write, &message, sizeof(message));
    _exit(121);
  }
  (void)close(stdout_write);
  (void)close(stderr_write);

  const int resources[] = {
      RLIMIT_CORE, RLIMIT_CPU, RLIMIT_FSIZE, RLIMIT_NOFILE, RLIMIT_AS,
  };
  const uint64_t values[] = {
      0,
      config->cpu_seconds,
      config->file_size_bytes,
      config->nofile,
      config->address_space_bytes,
  };
  const int stages[] = {
      CHILD_STAGE_RLIMIT_CORE,
      CHILD_STAGE_RLIMIT_CPU,
      CHILD_STAGE_RLIMIT_FSIZE,
      CHILD_STAGE_RLIMIT_NOFILE,
      CHILD_STAGE_RLIMIT_AS,
  };
  for (size_t index = 0; index < sizeof(resources) / sizeof(resources[0]);
       index += 1) {
    if (install_limit(resources[index], values[index])) {
      continue;
    }
    message.error_number = errno == 0 ? EINVAL : errno;
    message.reserved = stages[index];
    (void)write_all(control_write, &message, sizeof(message));
    _exit(122);
  }

  message.core_bytes = 0;
  message.cpu_seconds = config->cpu_seconds;
  message.file_size_bytes = config->file_size_bytes;
  message.nofile = config->nofile;
  message.address_space_bytes = config->address_space_bytes;
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
  const char *fault = getenv("PDF_TOOLS_SUPERVISOR_FAULT");
  if (fault != NULL && strcmp(fault, "prelease_timeout") == 0) {
    struct timespec delay = {.tv_sec = 1, .tv_nsec = 0};
    (void)nanosleep(&delay, NULL);
  }
#endif
  if (!write_all(control_write, &message, sizeof(message))) {
    _exit(123);
  }

  unsigned char gate = 0;
  if (!read_exact(gate_read, &gate, 1) || gate != 'G') {
    _exit(124);
  }
  (void)close(gate_read);

  execve(config->command[0], config->command, config->environment);

  memset(&message, 0, sizeof(message));
  message.magic = CONTROL_MAGIC;
  message.type = CONTROL_EXEC_FAILED;
  message.error_number = errno;
  message.reserved = CHILD_STAGE_EXEC;
  message.pid = getpid();
  message.pgid = getpgrp();
  (void)write_all(control_write, &message, sizeof(message));
  _exit(125);
}

static bool wait_ready(int fd, uint64_t start, uint64_t deadline_ns,
                       control_message *message) {
  unsigned char *cursor = (unsigned char *)message;
  size_t remaining = sizeof(*message);
  while (remaining > 0) {
    uint64_t elapsed = elapsed_ns(start, continuous_now());
    if (elapsed == UINT64_MAX || elapsed >= deadline_ns) {
      errno = ETIMEDOUT;
      return false;
    }
    uint64_t left_ms = (deadline_ns - elapsed + 999999) / 1000000;
    int timeout = left_ms > 50 ? 50 : (int)left_ms;
    struct pollfd descriptor = {.fd = fd, .events = POLLIN | POLLHUP};
    int result = poll(&descriptor, 1, timeout);
    if (result < 0 && errno == EINTR) {
      continue;
    }
    if (result < 0) {
      return false;
    }
    if (result == 0) {
      continue;
    }
    ssize_t count = read(fd, cursor, remaining);
    if (count > 0) {
      cursor += (size_t)count;
      remaining -= (size_t)count;
      continue;
    }
    if (count == 0) {
      errno = EPIPE;
      return false;
    }
    if (errno != EINTR) {
      return false;
    }
  }
  return true;
}

static bool process_details_with_fault(pid_t pid,
                                       struct rusage_info_v4 *usage,
                                       struct proc_taskallinfo *all,
                                       const char *fault_name) {
  struct rusage_info_v4 before;
  struct rusage_info_v4 after;
  memset(&before, 0, sizeof(before));
  memset(&after, 0, sizeof(after));
  memset(all, 0, sizeof(*all));
  if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&before) != 0) {
    return false;
  }
  int count = proc_pidinfo(pid, PROC_PIDTASKALLINFO, 0, all, sizeof(*all));
  if (count != (int)sizeof(*all)) {
    errno = count == 0 ? ESRCH : EIO;
    return false;
  }
  if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&after) != 0) {
    return false;
  }
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
  const char *fault = getenv("PDF_TOOLS_SUPERVISOR_FAULT");
  if (fault_name != NULL && fault != NULL &&
      strcmp(fault, fault_name) == 0) {
    after.ri_proc_start_abstime =
        saturating_add(after.ri_proc_start_abstime, 1);
  }
#else
  (void)fault_name;
#endif
  if (before.ri_proc_start_abstime != after.ri_proc_start_abstime) {
    errno = ESTALE;
    return false;
  }
  *usage = after;
  return true;
}

static bool process_details(pid_t pid, struct rusage_info_v4 *usage,
                            struct proc_taskallinfo *all) {
  return process_details_with_fault(pid, usage, all, NULL);
}

static process_identity *find_identity(observations *state, pid_t pid) {
  for (size_t index = 0; index < state->identity_count; index += 1) {
    if (state->identities[index].pid == pid) {
      return &state->identities[index];
    }
  }
  return NULL;
}

static bool remember_identity(observations *state, pid_t pid,
                              uint64_t start_abstime, bool escaped,
                              first_failure *failure) {
  process_identity *existing = find_identity(state, pid);
  if (existing != NULL) {
    if (existing->start_abstime != start_abstime) {
      set_failure(failure, FAILURE_PID_REUSE, 0);
      return false;
    }
    existing->escaped = existing->escaped || escaped;
    return true;
  }
  if (state->identity_count >= MAX_IDENTITIES) {
    set_failure(failure, FAILURE_ENUMERATION, EOVERFLOW);
    return false;
  }
  state->identities[state->identity_count++] =
      (process_identity){.pid = pid,
                         .start_abstime = start_abstime,
                         .escaped = escaped};
  return true;
}

static bool remember_escaped_pid(observations *state, pid_t pid) {
  for (size_t index = 0; index < state->escaped_count; index += 1) {
    if (state->escaped_pids[index] == pid) {
      return true;
    }
  }
  if (state->escaped_count >= MAX_PIDS) {
    return false;
  }
  state->escaped_pids[state->escaped_count++] = pid;
  return true;
}

static int list_group(pid_t pgid, pid_t pids[MAX_PIDS]) {
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
  const char *fault = getenv("PDF_TOOLS_SUPERVISOR_FAULT");
  if (fault != NULL && strcmp(fault, "enumeration_failure") == 0) {
    static unsigned calls = 0;
    calls += 1;
    if (calls == 2) {
      errno = EIO;
      return -1;
    }
  }
#endif
  int required = proc_listpgrppids(pgid, NULL, 0);
  if (required < 0 || required >= MAX_PIDS) {
    errno = required >= MAX_PIDS ? EOVERFLOW : errno;
    return -1;
  }
  int count =
      proc_listpgrppids(pgid, pids, (int)(MAX_PIDS * sizeof(pid_t)));
  if (count < 0 || count >= MAX_PIDS) {
    errno = count >= MAX_PIDS ? EOVERFLOW : errno;
    return -1;
  }
  return count;
}

static bool sample_children(pid_t parent, pid_t pgid, observations *state,
                            first_failure *failure) {
  pid_t children[MAX_PIDS];
  int count =
      proc_listchildpids(parent, children, (int)(MAX_PIDS * sizeof(pid_t)));
  if (count < 0) {
    if (errno == ESRCH) {
      state->sample_race_count += 1;
      return true;
    }
    set_failure(failure, FAILURE_ENUMERATION, errno);
    return false;
  }
  if (count >= MAX_PIDS) {
    set_failure(failure, FAILURE_ENUMERATION, EOVERFLOW);
    return false;
  }
  for (int index = 0; index < count; index += 1) {
    pid_t pid = children[index];
    if (pid <= 0) {
      continue;
    }
    struct rusage_info_v4 usage;
    struct proc_taskallinfo all;
    if (!process_details(pid, &usage, &all)) {
      if (errno == ESRCH) {
        state->sample_race_count += 1;
        continue;
      }
      set_failure(failure, FAILURE_ENUMERATION, errno);
      return false;
    }
    bool escaped = (pid_t)all.pbsd.pbi_pgid != pgid;
    if (!remember_identity(state, pid, usage.ri_proc_start_abstime, escaped,
                           failure)) {
      return false;
    }
    if (escaped) {
      state->escaped_session_detected = true;
      if (!remember_escaped_pid(state, pid)) {
        set_failure(failure, FAILURE_ENUMERATION, EOVERFLOW);
        return false;
      }
      set_failure(failure, FAILURE_ESCAPED_SESSION, 0);
    }
  }
  return true;
}

static bool sample_group(pid_t pgid, observations *state,
                         uint64_t footprint_limit, first_failure *failure) {
  pid_t pids[MAX_PIDS];
  int count = list_group(pgid, pids);
  if (count < 0) {
    set_failure(failure, FAILURE_ENUMERATION, errno);
    return false;
  }
  state->sample_count += 1;
  if ((uint64_t)count > state->max_group_members) {
    state->max_group_members = (uint64_t)count;
  }

  uint64_t physical = 0;
  uint64_t rss = 0;
  uint64_t virtual_bytes = 0;
  uint64_t cpu_ns = 0;
  for (int index = 0; index < count; index += 1) {
    pid_t pid = pids[index];
    if (pid <= 0) {
      continue;
    }
    struct rusage_info_v4 usage;
    struct proc_taskallinfo all;
    if (!process_details(pid, &usage, &all)) {
      if (errno == ESRCH) {
        state->sample_race_count += 1;
        continue;
      }
      set_failure(failure, FAILURE_ENUMERATION, errno);
      return false;
    }
    if ((pid_t)all.pbsd.pbi_pgid != pgid) {
      set_failure(failure, FAILURE_ENUMERATION, EPROTO);
      return false;
    }
    uint64_t observed_start = usage.ri_proc_start_abstime;
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
    const char *fault = getenv("PDF_TOOLS_SUPERVISOR_FAULT");
    if (fault != NULL && strcmp(fault, "pid_reuse") == 0 &&
        state->sample_count > 1) {
      observed_start = saturating_add(observed_start, 1);
    }
#endif
    if (!remember_identity(state, pid, observed_start, false, failure)) {
      return false;
    }
    physical = saturating_add(physical, usage.ri_phys_footprint);
    rss = saturating_add(rss, usage.ri_resident_size);
    virtual_bytes =
        saturating_add(virtual_bytes, all.ptinfo.pti_virtual_size);
    cpu_ns = saturating_add(
        cpu_ns, saturating_add(usage.ri_user_time, usage.ri_system_time));
    if (!sample_children(pid, pgid, state, failure)) {
      return false;
    }
  }
  if (physical > state->max_group_physical_footprint) {
    state->max_group_physical_footprint = physical;
  }
  if (rss > state->max_group_rss) {
    state->max_group_rss = rss;
  }
  if (virtual_bytes > state->max_group_virtual) {
    state->max_group_virtual = virtual_bytes;
  }
  if (cpu_ns > state->max_group_cpu_ns) {
    state->max_group_cpu_ns = cpu_ns;
  }
  if (physical > footprint_limit) {
    set_failure(failure, FAILURE_PHYSICAL_FOOTPRINT, 0);
  }
  return true;
}

static bool resume_matching_process(pid_t pid, uint64_t start_abstime) {
  struct rusage_info_v4 usage;
  struct proc_taskallinfo all;
  return process_details(pid, &usage, &all) &&
         usage.ri_proc_start_abstime == start_abstime &&
         kill(pid, SIGCONT) == 0;
}

static bool freeze_verified_process(pid_t pid, uint64_t start_abstime,
                                    pid_t expected_pgid,
                                    const char *identity_query_fault,
                                    const char *post_stop_query_fault,
                                    const char *pre_signal_fault,
                                    bool *introduced_stop) {
  *introduced_stop = false;
  struct rusage_info_v4 usage;
  struct proc_taskallinfo all;
  if (!process_details_with_fault(pid, &usage, &all,
                                  identity_query_fault) ||
      usage.ri_proc_start_abstime != start_abstime ||
      (expected_pgid > 0 && (pid_t)all.pbsd.pbi_pgid != expected_pgid)) {
    errno = ESTALE;
    return false;
  }

  *introduced_stop = all.pbsd.pbi_status != SSTOP;
  if (kill(pid, SIGSTOP) != 0) {
    return false;
  }

  bool stopped = false;
  for (unsigned attempt = 0; attempt < 200; attempt += 1) {
    if (!process_details_with_fault(pid, &usage, &all,
                                    post_stop_query_fault)) {
      if (*introduced_stop) {
        (void)resume_matching_process(pid, start_abstime);
      }
      return false;
    }
    if (usage.ri_proc_start_abstime != start_abstime ||
        (expected_pgid > 0 &&
         (pid_t)all.pbsd.pbi_pgid != expected_pgid)) {
      if (*introduced_stop) {
        (void)resume_matching_process(pid, start_abstime);
      }
      errno = ESTALE;
      return false;
    }
    if (all.pbsd.pbi_status == SSTOP) {
      stopped = true;
      break;
    }
    struct timespec delay = {.tv_sec = 0, .tv_nsec = 1000000};
    (void)nanosleep(&delay, NULL);
  }
  if (!stopped) {
    if (*introduced_stop) {
      (void)resume_matching_process(pid, start_abstime);
    }
    errno = ETIMEDOUT;
    return false;
  }

  if (!process_details_with_fault(pid, &usage, &all, pre_signal_fault) ||
      usage.ri_proc_start_abstime != start_abstime ||
      (expected_pgid > 0 && (pid_t)all.pbsd.pbi_pgid != expected_pgid) ||
      all.pbsd.pbi_status != SSTOP) {
    if (*introduced_stop) {
      (void)resume_matching_process(pid, start_abstime);
    }
    errno = ESTALE;
    return false;
  }
  return true;
}

static bool leader_has_exited(pid_t leader, bool *exited) {
  siginfo_t information;
  for (;;) {
    memset(&information, 0, sizeof(information));
    if (waitid(P_PID, (id_t)leader, &information,
               WEXITED | WNOHANG | WNOWAIT) == 0) {
      *exited = information.si_pid == leader;
      return true;
    }
    if (errno != EINTR) {
      return false;
    }
  }
}

static void terminate_known_processes(pid_t pgid, pid_t leader,
                                      const observations *state) {
  if (pgid > 0) {
    (void)kill(-pgid, SIGSTOP);
  }
  for (size_t index = 0; index < state->escaped_count; index += 1) {
    process_identity *identity = NULL;
    for (size_t candidate = 0; candidate < state->identity_count;
         candidate += 1) {
      if (state->identities[candidate].pid == state->escaped_pids[index]) {
        identity = (process_identity *)&state->identities[candidate];
        break;
      }
    }
    if (identity != NULL) {
      bool introduced_stop = false;
      if (freeze_verified_process(
              identity->pid, identity->start_abstime, 0,
              "escaped_identity_query_race",
              "escaped_post_stop_query_failure",
              "escaped_pre_signal_race",
              &introduced_stop)) {
        if (kill(identity->pid, SIGKILL) != 0 && introduced_stop) {
          (void)resume_matching_process(identity->pid,
                                        identity->start_abstime);
        }
      }
    }
  }
  if (pgid > 0) {
    (void)kill(-pgid, SIGKILL);
  }
  if (pgid <= 0 && leader > 0) {
    (void)kill(leader, SIGKILL);
  }
}

static bool group_empty(pid_t pgid) {
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
  const char *fault = getenv("PDF_TOOLS_SUPERVISOR_FAULT");
  if (fault != NULL && strcmp(fault, "cleanup_unproven") == 0) {
    errno = EIO;
    return false;
  }
#endif
  pid_t pids[MAX_PIDS];
  int count = list_group(pgid, pids);
  if (count < 0) {
    return false;
  }
  if (count != 0) {
    return false;
  }
  errno = 0;
  int present = kill(-pgid, 0);
  return present < 0 && errno == ESRCH;
}

static bool group_has_live_descendant(pid_t pgid, pid_t leader,
                                      first_failure *failure) {
  pid_t pids[MAX_PIDS];
  int count = list_group(pgid, pids);
  if (count < 0) {
    set_failure(failure, FAILURE_ENUMERATION, errno);
    return false;
  }
  for (int index = 0; index < count; index += 1) {
    if (pids[index] > 0 && pids[index] != leader) {
      return true;
    }
  }
  return false;
}

static bool emit_lease(int fd, pid_t leader, pid_t pgid,
                       uint64_t start_abstime) {
  char json[512];
  int length = snprintf(
      json, sizeof(json),
      "{\"leader_pid\":%d,\"leader_start_abstime\":%" PRIu64
      ",\"process_group_id\":%d,"
      "\"protocol\":\"pdf-tools.macos-eval-supervisor-lease.v1\"}\n",
      leader, start_abstime, pgid);
  return length > 0 && (size_t)length < sizeof(json) &&
         write_all(fd, json, (size_t)length);
}

static bool emit_evidence(int fd, bool controller_accepted,
                          const run_config *config, pid_t leader, pid_t pgid,
                          uint64_t leader_start, bool leader_reaped,
                          int leader_status, const first_failure *failure,
                          int child_setup_stage,
                          const observations *state,
                          const bounded_buffer *stdout_buffer,
                          const bounded_buffer *stderr_buffer,
                          uint64_t elapsed_continuous_ns,
                          bool original_group_empty) {
  char exit_code[32];
  char signal_code[32];
  if (!leader_reaped) {
    strcpy(exit_code, "null");
    strcpy(signal_code, "null");
  } else if (WIFEXITED(leader_status)) {
    (void)snprintf(exit_code, sizeof(exit_code), "%d",
                   WEXITSTATUS(leader_status));
    strcpy(signal_code, "null");
  } else if (WIFSIGNALED(leader_status)) {
    strcpy(exit_code, "null");
    (void)snprintf(signal_code, sizeof(signal_code), "%d",
                   WTERMSIG(leader_status));
  } else {
    strcpy(exit_code, "null");
    strcpy(signal_code, "null");
  }

  char json[MAX_JSON_BYTES];
  int length = snprintf(
      json, sizeof(json),
      "{\"capture\":{\"stderr_limit_exceeded\":%s,"
      "\"stderr_observed_bytes\":%" PRIu64
      ",\"stderr_retained_bytes\":%zu,\"stdout_limit_exceeded\":%s,"
      "\"stdout_observed_bytes\":%" PRIu64
      ",\"stdout_retained_bytes\":%zu},"
      "\"child_setup_stage\":%d,"
      "\"claim_boundary\":\"Sampled resource observations and inherited "
      "per-process limits only. No zero-overshoot, escaped-session "
      "containment, cgroup-equivalent isolation, filesystem isolation, "
      "network isolation, or hostile-code safety claim.\","
      "\"controller_accepted\":%s,\"controller_errno\":%d,"
      "\"controller_failure\":\"%s\","
      "\"leader\":{\"exit_code\":%s,\"pid\":%d,"
      "\"process_group_id\":%d,\"signal\":%s,\"start_abstime\":%" PRIu64
      "},"
      "\"limits\":{\"address_space_bytes\":%" PRIu64
      ",\"core_bytes\":0,\"cpu_seconds\":%" PRIu64
      ",\"deadline_ms\":%" PRIu64
      ",\"file_size_bytes\":%" PRIu64
      ",\"leader_exit_grace_ms\":%" PRIu64
      ",\"nofile\":%" PRIu64 ",\"sample_interval_ms\":%" PRIu64
      ",\"sampled_group_physical_footprint_max_bytes\":%" PRIu64
      ",\"stderr_max_bytes\":%" PRIu64 ",\"stdout_max_bytes\":%" PRIu64
      "},"
      "\"observations\":{\"elapsed_continuous_ns\":%" PRIu64
      ",\"escaped_session_detected\":%s,"
      "\"max_group_members\":%" PRIu64
      ",\"max_sampled_group_cpu_ns\":%" PRIu64
      ",\"max_sampled_group_physical_footprint_bytes\":%" PRIu64
      ",\"max_sampled_group_rss_bytes\":%" PRIu64
      ",\"max_sampled_group_virtual_bytes\":%" PRIu64
      ",\"observed_process_identity_count\":%zu,"
      "\"original_process_group_empty\":%s,"
      "\"sample_count\":%" PRIu64 ",\"sample_race_count\":%" PRIu64 "},"
      "\"protocol\":\"pdf-tools.macos-eval-supervisor.v1\"}\n",
      stderr_buffer->exceeded ? "true" : "false",
      stderr_buffer->observed_bytes, stderr_buffer->length,
      stdout_buffer->exceeded ? "true" : "false",
      stdout_buffer->observed_bytes, stdout_buffer->length, child_setup_stage,
      controller_accepted ? "true" : "false", failure->error_number,
      failure_name(failure->code), exit_code, leader, pgid, signal_code,
      leader_start, config->address_space_bytes, config->cpu_seconds,
      config->deadline_ms, config->file_size_bytes,
      config->leader_exit_grace_ms, config->nofile,
      config->sample_ms, config->physical_footprint_max_bytes,
      config->stderr_max_bytes, config->stdout_max_bytes,
      elapsed_continuous_ns,
      state->escaped_session_detected ? "true" : "false",
      state->max_group_members, state->max_group_cpu_ns,
      state->max_group_physical_footprint, state->max_group_rss,
      state->max_group_virtual, state->identity_count,
      original_group_empty ? "true" : "false", state->sample_count,
      state->sample_race_count);
  return length > 0 && (size_t)length < sizeof(json) &&
         write_all(fd, json, (size_t)length);
}

static int run_supervisor(const run_config *config) {
  if (!valid_parent_fd(config->evidence_fd) ||
      !valid_parent_fd(config->lease_fd)) {
    return 64;
  }
  install_signal_handlers();

  int stdout_pipe[2];
  int stderr_pipe[2];
  int control_pipe[2];
  int gate_pipe[2];
  if (pipe(stdout_pipe) != 0 || pipe(stderr_pipe) != 0 ||
      pipe(control_pipe) != 0 || pipe(gate_pipe) != 0) {
    return 65;
  }
  if (!set_cloexec(control_pipe[1]) || !set_cloexec(gate_pipe[0])) {
    return 66;
  }

  uint64_t started = continuous_now();
  uint64_t deadline_ns =
      config->deadline_ms > UINT64_MAX / UINT64_C(1000000)
          ? UINT64_MAX
          : config->deadline_ms * UINT64_C(1000000);

  pid_t leader = fork();
  if (leader < 0) {
    return 67;
  }
  if (leader == 0) {
    child_main(config, stdout_pipe[1], stderr_pipe[1], control_pipe[1],
               gate_pipe[0], stdout_pipe[0], stderr_pipe[0], control_pipe[0],
               gate_pipe[1]);
  }

  active_leader = leader;
  (void)close(stdout_pipe[1]);
  (void)close(stderr_pipe[1]);
  (void)close(control_pipe[1]);
  (void)close(gate_pipe[0]);

  control_message ready;
  memset(&ready, 0, sizeof(ready));
  first_failure failure = {.code = FAILURE_NONE, .error_number = 0};
  observations state;
  memset(&state, 0, sizeof(state));
  bounded_buffer stdout_buffer = {.limit = config->stdout_max_bytes};
  bounded_buffer stderr_buffer = {.limit = config->stderr_max_bytes};
  bool leader_reaped = false;
  bool leader_exited = false;
  uint64_t leader_exited_ns = 0;
  int leader_status = 0;
  pid_t pgid = -1;
  uint64_t leader_start = 0;
  bool lease_written = false;
  bool gate_opened = false;
  int child_setup_stage = CHILD_STAGE_NONE;
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
  const char *fault = getenv("PDF_TOOLS_SUPERVISOR_FAULT");
#endif

  if (!wait_ready(control_pipe[0], started, deadline_ns, &ready) ||
      ready.magic != CONTROL_MAGIC || ready.type != CONTROL_READY ||
      ready.pid != leader || ready.pgid != leader ||
      ready.error_number != 0 || ready.core_bytes != 0 ||
      ready.cpu_seconds != config->cpu_seconds ||
      ready.file_size_bytes != config->file_size_bytes ||
      ready.nofile != config->nofile ||
      ready.address_space_bytes != config->address_space_bytes) {
    set_failure(&failure, FAILURE_CHILD_SETUP,
                ready.error_number != 0 ? ready.error_number : errno);
    child_setup_stage = ready.reserved;
  } else {
    pgid = ready.pgid;
    active_pgid = pgid;
    struct rusage_info_v4 usage;
    struct proc_taskallinfo all;
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
    bool injected_prelease_enumeration =
        fault != NULL && strcmp(fault, "prelease_enumeration") == 0;
    if (injected_prelease_enumeration) {
      errno = EIO;
    }
#else
    bool injected_prelease_enumeration = false;
#endif
    if (injected_prelease_enumeration ||
        !process_details(leader, &usage, &all) ||
        (pid_t)all.pbsd.pbi_pgid != pgid ||
        !remember_identity(&state, leader, usage.ri_proc_start_abstime, false,
                           &failure)) {
      set_failure(&failure, FAILURE_ENUMERATION, errno);
    } else {
      leader_start = usage.ri_proc_start_abstime;
    }
  }

  if (failure.code == FAILURE_NONE) {
#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
    if (fault != NULL && strcmp(fault, "prelease_lease_failure") == 0) {
      (void)close(config->lease_fd);
    }
#endif
    lease_written = emit_lease(config->lease_fd, leader, pgid, leader_start);
    (void)close(config->lease_fd);
    if (!lease_written) {
      set_failure(&failure, FAILURE_LEASE, errno);
    }
  }
  if (failure.code == FAILURE_NONE) {
    unsigned char gate = 'G';
    gate_opened = write_all(gate_pipe[1], &gate, 1);
    if (!gate_opened) {
      set_failure(&failure, FAILURE_CHILD_SETUP, errno);
    }
  }
  (void)close(gate_pipe[1]);

#if defined(PDF_TOOLS_SUPERVISOR_TESTING)
  if (gate_opened && fault != NULL &&
      (strcmp(fault, "supervisor_crash") == 0 ||
       strcmp(fault,
              "supervisor_crash_cleanup_identity_query_race") == 0 ||
       strcmp(fault,
              "supervisor_crash_cleanup_post_stop_query_failure") == 0 ||
       strcmp(fault,
              "supervisor_crash_cleanup_pre_signal_race") == 0)) {
    _exit(99);
  }
  if (gate_opened && fault != NULL &&
      strcmp(fault, "supervisor_crash_delayed") == 0) {
    struct timespec delay = {.tv_sec = 0, .tv_nsec = 200000000};
    (void)nanosleep(&delay, NULL);
    _exit(99);
  }
  if (gate_opened && fault != NULL &&
      strcmp(fault, "supervisor_hang_ignore_term") == 0) {
    (void)signal(SIGTERM, SIG_IGN);
    for (;;) {
      (void)pause();
    }
  }
#endif

  if (!set_nonblocking(stdout_pipe[0]) ||
      !set_nonblocking(stderr_pipe[0]) ||
      !set_nonblocking(control_pipe[0])) {
    set_failure(&failure, FAILURE_INTERNAL, errno);
  }

  bool stdout_eof = false;
  bool stderr_eof = false;
  bool control_eof = false;
  bool termination_started = false;
  uint64_t termination_started_ns = 0;
  uint64_t next_sample_ns = 0;
  unsigned empty_streak = 0;
  bool original_group_empty = false;
  unsigned char control_bytes[sizeof(control_message)];
  size_t control_length = 0;

  for (;;) {
    uint64_t now = continuous_now();
    uint64_t elapsed = elapsed_ns(started, now);
    if (elapsed == UINT64_MAX) {
      set_failure(&failure, FAILURE_INTERNAL, EOVERFLOW);
    } else if (!termination_started && elapsed >= deadline_ns) {
      set_failure(&failure, FAILURE_DEADLINE, ETIMEDOUT);
    }

    if (gate_opened && pgid > 0 && !termination_started &&
        (state.sample_count == 0 || elapsed >= next_sample_ns)) {
      (void)sample_group(pgid, &state,
                         config->physical_footprint_max_bytes, &failure);
      next_sample_ns =
          saturating_add(elapsed, config->sample_ms * UINT64_C(1000000));
    }

    if (!drain_fd(stdout_pipe[0], &stdout_buffer, &stdout_eof)) {
      set_failure(&failure, FAILURE_INTERNAL, errno);
    }
    if (!drain_fd(stderr_pipe[0], &stderr_buffer, &stderr_eof)) {
      set_failure(&failure, FAILURE_INTERNAL, errno);
    }
    if (stdout_buffer.exceeded) {
      set_failure(&failure, FAILURE_STDOUT_LIMIT, 0);
    }
    if (stderr_buffer.exceeded) {
      set_failure(&failure, FAILURE_STDERR_LIMIT, 0);
    }

    if (!control_eof) {
      for (;;) {
        ssize_t count =
            read(control_pipe[0], control_bytes + control_length,
                 sizeof(control_bytes) - control_length);
        if (count > 0) {
          control_length += (size_t)count;
          if (control_length == sizeof(control_bytes)) {
            control_message message;
            memcpy(&message, control_bytes, sizeof(message));
            control_length = 0;
            if (message.magic != CONTROL_MAGIC ||
                message.type != CONTROL_EXEC_FAILED ||
                message.pid != leader || message.pgid != pgid) {
              set_failure(&failure, FAILURE_INTERNAL, EPROTO);
            } else {
              set_failure(&failure, FAILURE_EXEC, message.error_number);
              child_setup_stage = message.reserved;
            }
          }
          continue;
        }
        if (count == 0) {
          control_eof = true;
          break;
        }
        if (errno == EINTR) {
          continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
          break;
        }
        set_failure(&failure, FAILURE_INTERNAL, errno);
        break;
      }
    }

    bool leader_grace_pending = false;
    if (!leader_exited && failure.code == FAILURE_NONE) {
      if (!leader_has_exited(leader, &leader_exited)) {
        if (errno != EINTR) {
          set_failure(&failure, FAILURE_INTERNAL, errno);
        }
      } else if (leader_exited) {
        leader_exited_ns = elapsed;
      }
    }
    if (leader_exited && failure.code == FAILURE_NONE && pgid > 0 &&
        group_has_live_descendant(pgid, leader, &failure)) {
      uint64_t grace_ns =
          config->leader_exit_grace_ms > UINT64_MAX / UINT64_C(1000000)
              ? UINT64_MAX
              : config->leader_exit_grace_ms * UINT64_C(1000000);
      if (elapsed < saturating_add(leader_exited_ns, grace_ns)) {
        leader_grace_pending = true;
      } else {
        set_failure(&failure, FAILURE_LIVE_DESCENDANTS, 0);
      }
    }

    if (!termination_started &&
        (failure.code != FAILURE_NONE ||
         (leader_exited && !leader_grace_pending))) {
      /*
       * Keep the leader waitable and unreaped while signalling its process
       * group. Its reserved PID prevents another process from creating a new
       * group with the same identifier between observation and killpg.
       */
      terminate_known_processes(pgid, leader, &state);
      termination_started = true;
      termination_started_ns = elapsed;
    }

    if (termination_started) {
      if (pgid <= 0) {
        original_group_empty = true;
        empty_streak = 2;
      } else if (group_empty(pgid)) {
        empty_streak += 1;
        if (empty_streak >= 2) {
          original_group_empty = true;
        }
      } else {
        empty_streak = 0;
      }
      if (!leader_reaped) {
        pid_t waited = waitpid(leader, &leader_status, WNOHANG);
        if (waited == leader) {
          leader_reaped = true;
          active_leader = -1;
          if (!WIFEXITED(leader_status) ||
              WEXITSTATUS(leader_status) != 0) {
            if (failure.code == FAILURE_NONE) {
              set_failure(&failure, FAILURE_LEADER_EXIT, 0);
            }
          }
        }
      }
      if (elapsed != UINT64_MAX &&
          elapsed > saturating_add(termination_started_ns,
                                   UINT64_C(2000000000)) &&
          (!original_group_empty || !leader_reaped)) {
        set_failure(&failure, FAILURE_CLEANUP, ETIMEDOUT);
        break;
      }
    }

    if (termination_started && original_group_empty && leader_reaped &&
        stdout_eof && stderr_eof) {
      break;
    }

    struct pollfd descriptors[3] = {
        {.fd = stdout_pipe[0], .events = POLLIN | POLLHUP},
        {.fd = stderr_pipe[0], .events = POLLIN | POLLHUP},
        {.fd = control_pipe[0], .events = POLLIN | POLLHUP},
    };
    int timeout = (int)(config->sample_ms > 50 ? 50 : config->sample_ms);
    int result = poll(descriptors, 3, timeout);
    if (result < 0 && errno != EINTR) {
      set_failure(&failure, FAILURE_INTERNAL, errno);
    }
  }

  (void)close(stdout_pipe[0]);
  (void)close(stderr_pipe[0]);
  (void)close(control_pipe[0]);
  active_pgid = -1;
  active_leader = -1;

  uint64_t final_elapsed = elapsed_ns(started, continuous_now());
  bool leader_success =
      leader_reaped && WIFEXITED(leader_status) &&
      WEXITSTATUS(leader_status) == 0;
  bool accepted = failure.code == FAILURE_NONE && lease_written &&
                  gate_opened && leader_success && original_group_empty &&
                  !stdout_buffer.exceeded && !stderr_buffer.exceeded;

  if (accepted &&
      !write_all(STDOUT_FILENO, stdout_buffer.bytes, stdout_buffer.length)) {
    set_failure(&failure, FAILURE_INTERNAL, errno);
    accepted = false;
  }
  bool evidence_written =
      emit_evidence(config->evidence_fd, accepted, config, leader, pgid,
                    leader_start, leader_reaped, leader_status, &failure,
                    child_setup_stage, &state, &stdout_buffer, &stderr_buffer,
                    final_elapsed,
                    original_group_empty);
  (void)close(config->evidence_fd);
  free(stdout_buffer.bytes);
  free(stderr_buffer.bytes);
  if (!evidence_written) {
    return 68;
  }
  return accepted ? 0 : 1;
}

static bool parse_cleanup_config(int argc, char **argv, pid_t *pgid,
                                 pid_t *leader,
                                 uint64_t *leader_start_abstime,
                                 int *evidence_fd) {
  uint64_t parsed_pgid = 0;
  uint64_t parsed_leader = 0;
  bool seen_pgid = false;
  bool seen_leader = false;
  bool seen_start = false;
  bool seen_evidence = false;
  *evidence_fd = -1;
  for (int index = 2; index < argc; index += 1) {
    const char *value = NULL;
    if (!next_value(argc, argv, &index, &value)) {
      return false;
    }
    if (strcmp(argv[index - 1], "--pgid") == 0 && !seen_pgid) {
      seen_pgid = parse_u64(value, 2, INT32_MAX, &parsed_pgid);
      if (!seen_pgid) return false;
    } else if (strcmp(argv[index - 1], "--leader-pid") == 0 &&
               !seen_leader) {
      seen_leader = parse_u64(value, 2, INT32_MAX, &parsed_leader);
      if (!seen_leader) return false;
    } else if (strcmp(argv[index - 1], "--leader-start-abstime") == 0 &&
               !seen_start) {
      seen_start =
          parse_u64(value, 1, UINT64_MAX, leader_start_abstime);
      if (!seen_start) return false;
    } else if (strcmp(argv[index - 1], "--evidence-fd") == 0 &&
               !seen_evidence) {
      seen_evidence = parse_fd(value, evidence_fd);
      if (!seen_evidence) return false;
    } else {
      return false;
    }
  }
  *pgid = (pid_t)parsed_pgid;
  *leader = (pid_t)parsed_leader;
  return seen_pgid && seen_leader && seen_start && seen_evidence &&
         *pgid == *leader;
}

static int cleanup_supervisor(pid_t pgid, pid_t leader,
                              uint64_t leader_start_abstime,
                              int evidence_fd) {
  if (!valid_parent_fd(evidence_fd)) {
    return 64;
  }
  bool introduced_stop = false;
  bool identity_matched = freeze_verified_process(
      leader, leader_start_abstime, pgid,
      "supervisor_crash_cleanup_identity_query_race",
      "supervisor_crash_cleanup_post_stop_query_failure",
      "supervisor_crash_cleanup_pre_signal_race", &introduced_stop);
  if (identity_matched) {
    if (kill(-pgid, SIGKILL) != 0 && introduced_stop) {
      (void)resume_matching_process(leader, leader_start_abstime);
      identity_matched = false;
    }
  }
  bool empty = false;
  for (unsigned attempt = 0; attempt < 200; attempt += 1) {
    int status = 0;
    (void)waitpid(leader, &status, WNOHANG);
    if (group_empty(pgid)) {
      empty = true;
      break;
    }
    struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000};
    (void)nanosleep(&delay, NULL);
  }
  char json[1024];
  int length = snprintf(
      json, sizeof(json),
      "{\"claim_boundary\":\"Crash recovery kills only a still-live leader "
      "whose PID, process group, and start-time identity match the "
      "parent-owned lease. A missing leader leaves containment "
      "unproven.\",\"identity_matched\":%s,\"leader_pid\":%d,"
      "\"leader_start_abstime\":%" PRIu64
      ",\"original_process_group_empty\":%s,\"process_group_id\":%d,"
      "\"protocol\":\"pdf-tools.macos-eval-supervisor-cleanup.v1\"}\n",
      identity_matched ? "true" : "false", leader, leader_start_abstime,
      empty ? "true" : "false", pgid);
  bool written = length > 0 && (size_t)length < sizeof(json) &&
                 write_all(evidence_fd, json, (size_t)length);
  (void)close(evidence_fd);
  return written && identity_matched && empty ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    usage();
    return 64;
  }
  if (strcmp(argv[1], "run") == 0) {
    run_config config;
    if (!parse_run_config(argc, argv, &config)) {
      free(config.environment);
      usage();
      return 64;
    }
    int result = run_supervisor(&config);
    free(config.environment);
    return result;
  }
  if (strcmp(argv[1], "cleanup") == 0) {
    pid_t pgid = -1;
    pid_t leader = -1;
    uint64_t leader_start_abstime = 0;
    int evidence_fd = -1;
    if (!parse_cleanup_config(argc, argv, &pgid, &leader,
                              &leader_start_abstime, &evidence_fd)) {
      usage();
      return 64;
    }
    return cleanup_supervisor(pgid, leader, leader_start_abstime,
                              evidence_fd);
  }
  usage();
  return 64;
}
