#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <string.h>
#include <unistd.h>

#define INPUT_FD 4

static bool read_all(unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(INPUT_FD, bytes + offset, length - offset);
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

int main(int argc, char **argv) {
  static const unsigned char expected[] = {'%', 'P', 'D', 'F', '\n'};
  unsigned char observed[sizeof(expected)];
  unsigned char trailing = 0;
  int flags = fcntl(INPUT_FD, F_GETFL);
  if (argc != 2 || strcmp(argv[1], "/dev/fd/4") != 0 ||
      flags < 0 || (flags & O_ACCMODE) != O_RDONLY ||
      lseek(INPUT_FD, 0, SEEK_CUR) != 0 ||
      !read_all(observed, sizeof(observed)) ||
      memcmp(observed, expected, sizeof(expected)) != 0) {
    return 41;
  }
  for (;;) {
    ssize_t count = read(INPUT_FD, &trailing, 1);
    if (count == 0) {
      return 0;
    }
    if (count < 0 && errno == EINTR) {
      continue;
    }
    return 42;
  }
}
