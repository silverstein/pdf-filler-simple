#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/*
 * Exec-only qpdf budget launcher.
 *
 * This program deliberately creates no subprocess, process group, or session.
 * It verifies the inherited process group, applies process-local rlimits,
 * verifies an inherited read-only regular-file input on fd 4, reports the
 * applied values and input identity over fd 3, and execs qpdf in place.
 * execve() therefore preserves the PID, process group, session, limits, and
 * open input description. fd 3 is FD_CLOEXEC, so READY followed by EOF is the
 * close-on-exec boundary signal; fd 4 remains open across exec.
 */

#define CONTROL_FD 3
#define INPUT_FD 4
#define FRAME_BYTES 176
#define MAGIC_0 ((unsigned char)'Q')
#define MAGIC_1 ((unsigned char)'P')
#define MAGIC_2 ((unsigned char)'B')
#define MAGIC_3 ((unsigned char)'E')
#define PROTOCOL_VERSION 3

enum frame_type {
  FRAME_READY = 1,
  FRAME_ERROR = 2,
};

enum setup_stage {
  STAGE_PARSE = 1,
  STAGE_GROUP = 2,
  STAGE_CONTROL_FD = 3,
  STAGE_INPUT_FD = 4,
  STAGE_RLIMIT_CORE = 5,
  STAGE_RLIMIT_AS = 6,
  STAGE_RLIMIT_FSIZE = 7,
  STAGE_RLIMIT_CPU = 8,
  STAGE_RLIMIT_NOFILE = 9,
  STAGE_READY = 10,
  STAGE_EXEC = 11,
};

typedef struct {
  pid_t expected_parent_pid;
  pid_t expected_pgid;
  uint64_t address_space_headroom_bytes;
  uint64_t file_size_bytes;
  uint64_t cpu_soft_seconds;
  uint64_t cpu_hard_seconds;
  uint64_t nofile;
  uint64_t input_device;
  uint64_t input_inode;
  uint64_t input_bytes;
  uint64_t input_mode;
  uint64_t input_links;
  uint64_t input_owner;
  uint64_t input_group;
  const char *qpdf_path;
  int separator_index;
} launch_config;

extern char **environ;

static uint64_t frame_address_space_baseline_bytes = 0;
static uint64_t frame_address_space_headroom_bytes = 0;
static uint64_t frame_address_space_observed_bytes = 0;
static uint64_t frame_input_device = 0;
static uint64_t frame_input_inode = 0;
static uint64_t frame_input_bytes = 0;
static uint32_t frame_input_mode = 0;
static uint32_t frame_input_links = 0;
static uint32_t frame_input_owner = 0;
static uint32_t frame_input_group = 0;

static void put_u16(unsigned char *bytes, size_t offset, uint16_t value) {
  bytes[offset] = (unsigned char)((value >> 8) & UINT16_C(0xff));
  bytes[offset + 1] = (unsigned char)(value & UINT16_C(0xff));
}

static void put_u32(unsigned char *bytes, size_t offset, uint32_t value) {
  bytes[offset] = (unsigned char)((value >> 24) & UINT32_C(0xff));
  bytes[offset + 1] = (unsigned char)((value >> 16) & UINT32_C(0xff));
  bytes[offset + 2] = (unsigned char)((value >> 8) & UINT32_C(0xff));
  bytes[offset + 3] = (unsigned char)(value & UINT32_C(0xff));
}

static void put_u64(unsigned char *bytes, size_t offset, uint64_t value) {
  for (size_t index = 0; index < 8; index += 1) {
    unsigned shift = (unsigned)((7 - index) * 8);
    bytes[offset + index] =
        (unsigned char)((value >> shift) & UINT64_C(0xff));
  }
}

static bool write_all(int fd, const unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count > 0) {
      offset += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

static uint64_t rlim_to_u64(rlim_t value) {
  if (value == RLIM_INFINITY) {
    return UINT64_MAX;
  }
  return (uint64_t)value;
}

static bool read_limits(struct rlimit limits[5]) {
  return getrlimit(RLIMIT_AS, &limits[0]) == 0 &&
         getrlimit(RLIMIT_FSIZE, &limits[1]) == 0 &&
         getrlimit(RLIMIT_CPU, &limits[2]) == 0 &&
         getrlimit(RLIMIT_NOFILE, &limits[3]) == 0 &&
         getrlimit(RLIMIT_CORE, &limits[4]) == 0;
}

static bool emit_frame(enum frame_type type, uint16_t sequence,
                       enum setup_stage stage, int error_number,
                       const struct rlimit limits[5]) {
  unsigned char frame[FRAME_BYTES];
  memset(frame, 0, sizeof(frame));
  frame[0] = MAGIC_0;
  frame[1] = MAGIC_1;
  frame[2] = MAGIC_2;
  frame[3] = MAGIC_3;
  frame[4] = PROTOCOL_VERSION;
  frame[5] = (unsigned char)type;
  put_u16(frame, 6, sequence);
  put_u16(frame, 8, (uint16_t)stage);
  put_u32(frame, 12, (uint32_t)error_number);
  put_u32(frame, 16, (uint32_t)getpid());
  put_u32(frame, 20, (uint32_t)getpgrp());
  put_u32(frame, 24, (uint32_t)getsid(0));
  size_t offset = 32;
  for (size_t index = 0; index < 5; index += 1) {
    put_u64(frame, offset, rlim_to_u64(limits[index].rlim_cur));
    put_u64(frame, offset + 8, rlim_to_u64(limits[index].rlim_max));
    offset += 16;
  }
  put_u64(frame, 112, frame_address_space_baseline_bytes);
  put_u64(frame, 120, frame_address_space_headroom_bytes);
  put_u64(frame, 128, frame_address_space_observed_bytes);
  put_u64(frame, 136, frame_input_device);
  put_u64(frame, 144, frame_input_inode);
  put_u64(frame, 152, frame_input_bytes);
  put_u32(frame, 160, frame_input_mode);
  put_u32(frame, 164, frame_input_links);
  put_u32(frame, 168, frame_input_owner);
  put_u32(frame, 172, frame_input_group);
  return write_all(CONTROL_FD, frame, sizeof(frame));
}

static void fail_setup(enum setup_stage stage, int error_number,
                       uint16_t sequence) {
  struct rlimit limits[5];
  memset(limits, 0, sizeof(limits));
  (void)read_limits(limits);
  if (!emit_frame(FRAME_ERROR, sequence, stage, error_number, limits)) {
    _exit(124);
  }
  _exit(stage == STAGE_EXEC ? 126 : 125);
}

static bool decimal_u64(const char *text, uint64_t minimum, uint64_t maximum,
                        uint64_t *output) {
  if (text == NULL || text[0] == '\0' || text[0] == '+' || text[0] == '-') {
    return false;
  }
  errno = 0;
  char *end = NULL;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0') {
    return false;
  }
  uint64_t converted = (uint64_t)value;
  if (converted < minimum || converted > maximum) {
    return false;
  }
  *output = converted;
  return true;
}

static bool parse_arguments(int argc, char **argv, launch_config *config) {
  if (argc < 29) {
    return false;
  }
  memset(config, 0, sizeof(*config));
  bool seen_parent_pid = false;
  bool seen_pgid = false;
  bool seen_as = false;
  bool seen_fsize = false;
  bool seen_cpu_soft = false;
  bool seen_cpu_hard = false;
  bool seen_nofile = false;
  bool seen_input_device = false;
  bool seen_input_inode = false;
  bool seen_input_bytes = false;
  bool seen_input_mode = false;
  bool seen_input_links = false;
  bool seen_input_owner = false;
  bool seen_input_group = false;
  bool seen_qpdf = false;
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "--") == 0) {
      config->separator_index = index;
      break;
    }
    if (index + 1 >= argc) {
      return false;
    }
    const char *name = argv[index];
    const char *value = argv[index + 1];
    uint64_t parsed = 0;
    if (strcmp(name, "--expected-parent-pid") == 0 && !seen_parent_pid &&
        decimal_u64(value, 2, INT_MAX, &parsed)) {
      config->expected_parent_pid = (pid_t)parsed;
      seen_parent_pid = true;
    } else if (strcmp(name, "--expected-pgid") == 0 && !seen_pgid &&
        decimal_u64(value, 2, INT_MAX, &parsed)) {
      config->expected_pgid = (pid_t)parsed;
      seen_pgid = true;
    } else if (strcmp(name, "--as-headroom-bytes") == 0 && !seen_as &&
               decimal_u64(value, UINT64_C(16777216),
                           UINT64_C(549755813888), &parsed)) {
      config->address_space_headroom_bytes = parsed;
      seen_as = true;
    } else if (strcmp(name, "--fsize-bytes") == 0 && !seen_fsize &&
               decimal_u64(value, UINT64_C(1048576),
                           UINT64_C(1099511627776), &parsed)) {
      config->file_size_bytes = parsed;
      seen_fsize = true;
    } else if (strcmp(name, "--cpu-soft-seconds") == 0 && !seen_cpu_soft &&
               decimal_u64(value, 1, 3600, &parsed)) {
      config->cpu_soft_seconds = parsed;
      seen_cpu_soft = true;
    } else if (strcmp(name, "--cpu-hard-seconds") == 0 && !seen_cpu_hard &&
               decimal_u64(value, 1, 3601, &parsed)) {
      config->cpu_hard_seconds = parsed;
      seen_cpu_hard = true;
    } else if (strcmp(name, "--nofile") == 0 && !seen_nofile &&
               decimal_u64(value, 4, 4096, &parsed)) {
      config->nofile = parsed;
      seen_nofile = true;
    } else if (strcmp(name, "--input-device") == 0 && !seen_input_device &&
               decimal_u64(value, 1, UINT64_MAX, &parsed)) {
      config->input_device = parsed;
      seen_input_device = true;
    } else if (strcmp(name, "--input-inode") == 0 && !seen_input_inode &&
               decimal_u64(value, 1, UINT64_MAX, &parsed)) {
      config->input_inode = parsed;
      seen_input_inode = true;
    } else if (strcmp(name, "--input-bytes") == 0 && !seen_input_bytes &&
               decimal_u64(value, 1, UINT64_C(262144000), &parsed)) {
      config->input_bytes = parsed;
      seen_input_bytes = true;
    } else if (strcmp(name, "--input-mode") == 0 && !seen_input_mode &&
               decimal_u64(value, 0, UINT64_C(0777), &parsed)) {
      config->input_mode = parsed;
      seen_input_mode = true;
    } else if (strcmp(name, "--input-links") == 0 && !seen_input_links &&
               decimal_u64(value, 1, 1, &parsed)) {
      config->input_links = parsed;
      seen_input_links = true;
    } else if (strcmp(name, "--input-owner") == 0 && !seen_input_owner &&
               decimal_u64(value, 0, UINT32_MAX, &parsed)) {
      config->input_owner = parsed;
      seen_input_owner = true;
    } else if (strcmp(name, "--input-group") == 0 && !seen_input_group &&
               decimal_u64(value, 0, UINT32_MAX, &parsed)) {
      config->input_group = parsed;
      seen_input_group = true;
    } else if (strcmp(name, "--qpdf") == 0 && !seen_qpdf &&
               value[0] == '/') {
      config->qpdf_path = value;
      seen_qpdf = true;
    } else {
      return false;
    }
    index += 1;
  }
  int input_argument_count = 0;
  if (config->separator_index > 0) {
    for (int index = config->separator_index + 1; index < argc; index += 1) {
      if (strcmp(argv[index], "/dev/fd/4") == 0) {
        input_argument_count += 1;
      }
    }
  }
  return seen_parent_pid && seen_pgid && seen_as && seen_fsize &&
         seen_cpu_soft && seen_cpu_hard && seen_nofile &&
         seen_input_device && seen_input_inode && seen_input_bytes &&
         seen_input_mode && seen_input_links && seen_input_owner &&
         seen_input_group && seen_qpdf &&
         config->cpu_hard_seconds >= config->cpu_soft_seconds &&
         config->separator_index > 0 &&
         config->separator_index < argc &&
         input_argument_count == 1;
}

static bool verify_input_descriptor(const launch_config *config) {
  int status_flags = fcntl(INPUT_FD, F_GETFL);
  int descriptor_flags = fcntl(INPUT_FD, F_GETFD);
  struct stat input;
  if (status_flags < 0 || descriptor_flags < 0 ||
      (status_flags & O_ACCMODE) != O_RDONLY ||
      fstat(INPUT_FD, &input) != 0 ||
      !S_ISREG(input.st_mode) || input.st_size < 1 || input.st_nlink != 1 ||
      (uint64_t)input.st_dev != config->input_device ||
      (uint64_t)input.st_ino != config->input_inode ||
      (uint64_t)input.st_size != config->input_bytes ||
      (uint64_t)(input.st_mode & 0777) != config->input_mode ||
      (uint64_t)input.st_nlink != config->input_links ||
      (uint64_t)input.st_uid != config->input_owner ||
      (uint64_t)input.st_gid != config->input_group ||
      lseek(INPUT_FD, 0, SEEK_SET) != 0 ||
      fcntl(INPUT_FD, F_SETFD, descriptor_flags & ~FD_CLOEXEC) != 0) {
    return false;
  }
  int reread_flags = fcntl(INPUT_FD, F_GETFD);
  if (reread_flags < 0 || (reread_flags & FD_CLOEXEC) != 0 ||
      lseek(INPUT_FD, 0, SEEK_CUR) != 0) {
    return false;
  }
  frame_input_device = (uint64_t)input.st_dev;
  frame_input_inode = (uint64_t)input.st_ino;
  frame_input_bytes = (uint64_t)input.st_size;
  frame_input_mode = (uint32_t)(input.st_mode & 0777);
  frame_input_links = (uint32_t)input.st_nlink;
  frame_input_owner = (uint32_t)input.st_uid;
  frame_input_group = (uint32_t)input.st_gid;
  return true;
}

static bool exact_descriptor_set(void) {
  struct proc_fdinfo descriptors[128];
  int bytes = proc_pidinfo(
      getpid(),
      PROC_PIDLISTFDS,
      0,
      descriptors,
      (int)sizeof(descriptors));
  if (bytes <= 0 || bytes >= (int)sizeof(descriptors) ||
      bytes % (int)sizeof(descriptors[0]) != 0) {
    return false;
  }
  bool seen[INPUT_FD + 1];
  memset(seen, 0, sizeof(seen));
  int count = bytes / (int)sizeof(descriptors[0]);
  for (int index = 0; index < count; index += 1) {
    int descriptor = descriptors[index].proc_fd;
    if (descriptor < 0 || descriptor > INPUT_FD || seen[descriptor]) {
      return false;
    }
    seen[descriptor] = true;
  }
  for (int descriptor = 0; descriptor <= INPUT_FD; descriptor += 1) {
    if (!seen[descriptor]) {
      return false;
    }
  }
  errno = 0;
  return true;
}

static bool apply_exact_limit(int resource, uint64_t current, uint64_t maximum,
                              struct rlimit *observed) {
  struct rlimit requested = {
      .rlim_cur = (rlim_t)current,
      .rlim_max = (rlim_t)maximum,
  };
  if ((uint64_t)requested.rlim_cur != current ||
      (uint64_t)requested.rlim_max != maximum ||
      setrlimit(resource, &requested) != 0 ||
      getrlimit(resource, observed) != 0) {
    return false;
  }
  return rlim_to_u64(observed->rlim_cur) == current &&
         rlim_to_u64(observed->rlim_max) == maximum;
}

static bool current_virtual_size(uint64_t *output) {
  mach_task_basic_info_data_t information;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  kern_return_t result = task_info(
      mach_task_self(),
      MACH_TASK_BASIC_INFO,
      (task_info_t)&information,
      &count);
  if (result != KERN_SUCCESS || count < MACH_TASK_BASIC_INFO_COUNT) {
    return false;
  }
  *output = (uint64_t)information.virtual_size;
  return *output > 0;
}

int main(int argc, char **argv) {
  launch_config config;
  if (!parse_arguments(argc, argv, &config)) {
    fail_setup(STAGE_PARSE, EINVAL, 0);
  }
  errno = 0;
  pid_t parent_pgid = getpgid(config.expected_parent_pid);
  pid_t parent_sid = getsid(config.expected_parent_pid);
  pid_t inherited_sid = getsid(0);
  if (getppid() != config.expected_parent_pid ||
      getpgrp() != config.expected_pgid ||
      parent_pgid != config.expected_pgid ||
      inherited_sid < 1 || parent_sid != inherited_sid) {
    fail_setup(STAGE_GROUP, errno == 0 ? ESTALE : errno, 0);
  }
  int descriptor_flags = fcntl(CONTROL_FD, F_GETFD);
  if (descriptor_flags < 0 ||
      fcntl(CONTROL_FD, F_SETFD, descriptor_flags | FD_CLOEXEC) != 0) {
    fail_setup(STAGE_CONTROL_FD, errno, 0);
  }
  if (!verify_input_descriptor(&config) || !exact_descriptor_set()) {
    fail_setup(STAGE_INPUT_FD, errno == 0 ? ESTALE : errno, 0);
  }

  struct rlimit observed[5];
  if (!apply_exact_limit(RLIMIT_CORE, 0, 0, &observed[4])) {
    fail_setup(STAGE_RLIMIT_CORE, errno == 0 ? EINVAL : errno, 0);
  }
  frame_address_space_headroom_bytes =
      config.address_space_headroom_bytes;
  if (!current_virtual_size(&frame_address_space_baseline_bytes)) {
    fail_setup(STAGE_RLIMIT_AS, EIO, 0);
  }
  if (frame_address_space_baseline_bytes >
      UINT64_MAX - frame_address_space_headroom_bytes) {
    fail_setup(STAGE_RLIMIT_AS, EOVERFLOW, 0);
  }
  uint64_t address_space_limit =
      frame_address_space_baseline_bytes +
      frame_address_space_headroom_bytes;
  if (!apply_exact_limit(RLIMIT_AS, address_space_limit,
                         address_space_limit, &observed[0])) {
    fail_setup(STAGE_RLIMIT_AS, errno == 0 ? EINVAL : errno, 0);
  }
  if (!current_virtual_size(&frame_address_space_observed_bytes)) {
    fail_setup(STAGE_RLIMIT_AS, EIO, 0);
  }
  if (frame_address_space_observed_bytes > address_space_limit) {
    fail_setup(STAGE_RLIMIT_AS, EOVERFLOW, 0);
  }
  if (!apply_exact_limit(RLIMIT_FSIZE, config.file_size_bytes,
                         config.file_size_bytes, &observed[1])) {
    fail_setup(STAGE_RLIMIT_FSIZE, errno == 0 ? EINVAL : errno, 0);
  }
  if (!apply_exact_limit(RLIMIT_CPU, config.cpu_soft_seconds,
                         config.cpu_hard_seconds, &observed[2])) {
    fail_setup(STAGE_RLIMIT_CPU, errno == 0 ? EINVAL : errno, 0);
  }
  if (!apply_exact_limit(RLIMIT_NOFILE, config.nofile, config.nofile,
                         &observed[3])) {
    fail_setup(STAGE_RLIMIT_NOFILE, errno == 0 ? EINVAL : errno, 0);
  }
  if (!read_limits(observed)) {
    fail_setup(STAGE_READY, errno == 0 ? EINVAL : errno, 0);
  }
  if (!emit_frame(FRAME_READY, 0, STAGE_READY, 0, observed)) {
    _exit(124);
  }

  argv[config.separator_index] = (char *)config.qpdf_path;
  execve(config.qpdf_path, &argv[config.separator_index], environ);
  fail_setup(STAGE_EXEC, errno, 1);
}
