#if !defined(__APPLE__) || !defined(__MACH__)
#error "docling-macos-supervisor-candidate requires Darwin"
#endif

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

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

static void sleep_ms(uint64_t milliseconds) {
  struct timespec requested = {
      .tv_sec = (time_t)(milliseconds / 1000),
      .tv_nsec = (long)((milliseconds % 1000) * UINT64_C(1000000)),
  };
  while (nanosleep(&requested, &requested) != 0 && errno == EINTR) {
  }
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

static bool read_exact_and_eof(int fd, void *bytes, size_t length) {
  unsigned char *cursor = bytes;
  size_t remaining = length;
  while (remaining > 0) {
    ssize_t count = read(fd, cursor, remaining);
    if (count > 0) {
      cursor += (size_t)count;
      remaining -= (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  unsigned char extra = 0;
  ssize_t count;
  do {
    count = read(fd, &extra, 1);
  } while (count < 0 && errno == EINTR);
  return count == 0;
}

static bool hard_limit_cannot_be_raised(int resource) {
  struct rlimit observed;
  if (getrlimit(resource, &observed) != 0 ||
      observed.rlim_max == RLIM_INFINITY ||
      observed.rlim_max == (rlim_t)UINT64_MAX) {
    return false;
  }
  struct rlimit raised = observed;
  raised.rlim_max += 1;
  errno = 0;
  return setrlimit(resource, &raised) != 0 && errno == EPERM;
}

static int emit_success(const char *extra) {
  char json[512];
  int length =
      snprintf(json, sizeof(json), "{%s%s\"ok\":true}\n",
               extra == NULL ? "" : extra, extra == NULL ? "" : ",");
  return length > 0 && (size_t)length < sizeof(json) &&
                 write_all(STDOUT_FILENO, json, (size_t)length)
             ? 0
             : 1;
}

static int spam_fd(int fd, uint64_t bytes) {
  unsigned char block[65536];
  memset(block, fd == STDOUT_FILENO ? 'O' : 'E', sizeof(block));
  while (bytes > 0) {
    size_t count = bytes < sizeof(block) ? (size_t)bytes : sizeof(block);
    if (!write_all(fd, block, count)) {
      return 1;
    }
    bytes -= count;
  }
  return 0;
}

static int write_continuously(int fd) {
  unsigned char block[65536];
  memset(block, fd == STDOUT_FILENO ? 'O' : 'E', sizeof(block));
  while (write_all(fd, block, sizeof(block))) {
  }
  return 1;
}

static int emit_large_json(uint64_t content_bytes) {
  const char prefix[] = "{\"data\":\"";
  const char suffix[] = "\",\"ok\":true}\n";
  if (!write_all(STDOUT_FILENO, prefix, sizeof(prefix) - 1)) {
    return 1;
  }
  unsigned char block[65536];
  memset(block, 'A', sizeof(block));
  while (content_bytes > 0) {
    size_t count =
        content_bytes < sizeof(block) ? (size_t)content_bytes : sizeof(block);
    if (!write_all(STDOUT_FILENO, block, count)) {
      return 1;
    }
    content_bytes -= count;
  }
  return write_all(STDOUT_FILENO, suffix, sizeof(suffix) - 1) ? 0 : 1;
}

static uint64_t monotonic_ns(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    return 0;
  }
  return (uint64_t)now.tv_sec * UINT64_C(1000000000) +
         (uint64_t)now.tv_nsec;
}

static void busy_for_ms(uint64_t milliseconds) {
  uint64_t start = monotonic_ns();
  uint64_t duration = milliseconds * UINT64_C(1000000);
  volatile uint64_t accumulator = 0;
  while (monotonic_ns() - start < duration) {
    accumulator += 1;
  }
  (void)accumulator;
}

static int spawn_sleeping_children(uint64_t count, uint64_t milliseconds,
                                   bool wait_for_children) {
  pid_t *children = calloc((size_t)count, sizeof(pid_t));
  if (children == NULL) {
    return 1;
  }
  for (uint64_t index = 0; index < count; index += 1) {
    pid_t child = fork();
    if (child < 0) {
      free(children);
      return 1;
    }
    if (child == 0) {
      sleep_ms(milliseconds);
      _exit(0);
    }
    children[index] = child;
  }
  if (wait_for_children) {
    for (uint64_t index = 0; index < count; index += 1) {
      int status = 0;
      if (waitpid(children[index], &status, 0) != children[index] ||
          !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        free(children);
        return 1;
      }
    }
  }
  free(children);
  return 0;
}

static int write_sentinel_after(const char *filename, uint64_t milliseconds) {
  sleep_ms(milliseconds);
  int fd = open(filename, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) {
    return 1;
  }
  const char bytes[] = "escaped\n";
  bool written = write_all(fd, bytes, sizeof(bytes) - 1);
  (void)close(fd);
  return written ? 0 : 1;
}

static int create_sentinel(const char *filename) {
  int fd = open(filename, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) {
    return 1;
  }
  const char bytes[] = "started\n";
  bool written = write_all(fd, bytes, sizeof(bytes) - 1);
  (void)close(fd);
  return written ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    return 64;
  }
  const char *mode = argv[1];

  if (strcmp(mode, "success") == 0) {
    return emit_success(NULL);
  }
  if (strcmp(mode, "raise-limits") == 0) {
    bool blocked =
        hard_limit_cannot_be_raised(RLIMIT_CORE) &&
        hard_limit_cannot_be_raised(RLIMIT_CPU) &&
        hard_limit_cannot_be_raised(RLIMIT_FSIZE) &&
        hard_limit_cannot_be_raised(RLIMIT_NOFILE) &&
        hard_limit_cannot_be_raised(RLIMIT_AS);
    return blocked ? emit_success("\"hard_limits_unraiseable\":true") : 2;
  }
  if (strcmp(mode, "spam-stdout") == 0 ||
      strcmp(mode, "spam-stderr") == 0) {
    uint64_t bytes = 0;
    if (argc != 3 || !parse_u64(argv[2], 1, UINT64_C(1073741824), &bytes)) {
      return 64;
    }
    return spam_fd(strcmp(mode, "spam-stdout") == 0 ? STDOUT_FILENO
                                                     : STDERR_FILENO,
                   bytes);
  }
  if (strcmp(mode, "continuous-stdout") == 0) {
    return write_continuously(STDOUT_FILENO);
  }
  if (strcmp(mode, "large-json") == 0) {
    uint64_t bytes = 0;
    if (argc != 3 || !parse_u64(argv[2], 1, UINT64_C(16700000), &bytes)) {
      return 64;
    }
    return emit_large_json(bytes);
  }
  if (strcmp(mode, "assert-input-env") == 0) {
    if (argc != 3) {
      return 64;
    }
    const char *observed = getenv("PDF_TEST_TOKEN");
    char input[10];
    if (observed == NULL || strcmp(observed, argv[2]) != 0 ||
        !read_exact_and_eof(STDIN_FILENO, input, 9) ||
        memcmp(input, "ORIGINAL\n", 9) != 0) {
      return 2;
    }
    return emit_success(NULL);
  }
  if (strcmp(mode, "signal-and-sleep") == 0) {
    uint64_t milliseconds = 0;
    if (argc != 4 || !parse_u64(argv[3], 1, 10000, &milliseconds) ||
        create_sentinel(argv[2]) != 0) {
      return 64;
    }
    sleep_ms(milliseconds);
    return emit_success(NULL);
  }
  if (strcmp(mode, "sentinel-after") == 0) {
    uint64_t milliseconds = 0;
    if (argc != 4 || !parse_u64(argv[3], 1, 10000, &milliseconds)) {
      return 64;
    }
    return write_sentinel_after(argv[2], milliseconds);
  }
  if (strcmp(mode, "sleep") == 0 ||
      strcmp(mode, "just-in-time") == 0 ||
      strcmp(mode, "ignore-signals") == 0) {
    uint64_t milliseconds = 0;
    if (argc != 3 ||
        !parse_u64(argv[2], 1, UINT64_C(600000), &milliseconds)) {
      return 64;
    }
    if (strcmp(mode, "ignore-signals") == 0) {
      signal(SIGINT, SIG_IGN);
      signal(SIGTERM, SIG_IGN);
      signal(SIGHUP, SIG_IGN);
    }
    sleep_ms(milliseconds);
    return emit_success(NULL);
  }
  if (strcmp(mode, "partial-json") == 0) {
    const char bytes[] = "{\"ok\":";
    return write_all(STDOUT_FILENO, bytes, sizeof(bytes) - 1) ? 0 : 1;
  }
  if (strcmp(mode, "memory-growth") == 0) {
    uint64_t bytes = 0;
    if (argc != 3 || !parse_u64(argv[2], 4096, UINT64_C(1073741824),
                                 &bytes) ||
        bytes > SIZE_MAX) {
      return 64;
    }
    volatile unsigned char *memory = malloc((size_t)bytes);
    if (memory == NULL) {
      return 3;
    }
    for (size_t offset = 0; offset < (size_t)bytes; offset += 4096) {
      memory[offset] = (unsigned char)(offset & 0xff);
    }
    sleep_ms(5000);
    free((void *)memory);
    return emit_success(NULL);
  }
  if (strcmp(mode, "multiple-children") == 0) {
    uint64_t count = 0;
    uint64_t milliseconds = 0;
    if (argc != 4 || !parse_u64(argv[2], 1, 64, &count) ||
        !parse_u64(argv[3], 1, 10000, &milliseconds) ||
        spawn_sleeping_children(count, milliseconds, true) != 0) {
      return 64;
    }
    return emit_success(NULL);
  }
  if (strcmp(mode, "leader-exit-live-descendant") == 0) {
    if (argc != 3) {
      return 64;
    }
    pid_t child = fork();
    if (child < 0) {
      return 1;
    }
    if (child == 0) {
      signal(SIGINT, SIG_IGN);
      signal(SIGTERM, SIG_IGN);
      signal(SIGHUP, SIG_IGN);
      _exit(write_sentinel_after(argv[2], 750));
    }
    return emit_success(NULL);
  }
  if (strcmp(mode, "escaped-session") == 0) {
    if (argc != 3) {
      return 64;
    }
    pid_t child = fork();
    if (child < 0) {
      return 1;
    }
    if (child == 0) {
      if (setsid() < 0) {
        _exit(2);
      }
      signal(SIGINT, SIG_IGN);
      signal(SIGTERM, SIG_IGN);
      signal(SIGHUP, SIG_IGN);
      _exit(write_sentinel_after(argv[2], 1000));
    }
    sleep_ms(3000);
    return emit_success(NULL);
  }
  if (strcmp(mode, "short-lived-cpu-children") == 0) {
    uint64_t count = 0;
    uint64_t milliseconds = 0;
    if (argc != 4 || !parse_u64(argv[2], 1, 128, &count) ||
        !parse_u64(argv[3], 1, 1000, &milliseconds)) {
      return 64;
    }
    pid_t *children = calloc((size_t)count, sizeof(pid_t));
    if (children == NULL) {
      return 1;
    }
    for (uint64_t index = 0; index < count; index += 1) {
      pid_t child = fork();
      if (child < 0) {
        free(children);
        return 1;
      }
      if (child == 0) {
        busy_for_ms(milliseconds);
        _exit(0);
      }
      children[index] = child;
    }
    for (uint64_t index = 0; index < count; index += 1) {
      int status = 0;
      if (waitpid(children[index], &status, 0) != children[index]) {
        free(children);
        return 1;
      }
    }
    free(children);
    return emit_success(NULL);
  }
  if (strcmp(mode, "crash") == 0) {
    abort();
  }
  return 64;
}
