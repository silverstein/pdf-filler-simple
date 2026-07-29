#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <limits.h>
#include <mach/mach.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>

/*
 * Mechanism-only exec target for qpdf-macos-budget-exec tests.
 *
 * A 64 MiB anonymous mapping must first succeed as an ambient positive
 * control. The inherited finite RLIMIT_AS must then reject a new mapping that
 * is larger than the remaining VM-map allowance. No pages are touched, so
 * this exercises address-space enforcement without consuming the requested
 * physical memory.
 */

static int current_virtual_size(uint64_t *output) {
  mach_task_basic_info_data_t information;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  kern_return_t result = task_info(
      mach_task_self(),
      MACH_TASK_BASIC_INFO,
      (task_info_t)&information,
      &count);
  if (result != KERN_SUCCESS || count < MACH_TASK_BASIC_INFO_COUNT) {
    return 0;
  }
  *output = (uint64_t)information.virtual_size;
  return *output > 0;
}

int main(void) {
  struct rlimit limit;
  uint64_t current = 0;
  if (getrlimit(RLIMIT_AS, &limit) != 0 ||
      limit.rlim_cur == RLIM_INFINITY ||
      limit.rlim_cur != limit.rlim_max ||
      !current_virtual_size(&current)) {
    return 40;
  }
  uint64_t maximum = (uint64_t)limit.rlim_cur;
  if (current > maximum) {
    return 41;
  }
  const size_t control_length = (size_t)UINT64_C(67108864);
  void *control = mmap(
      NULL,
      control_length,
      PROT_NONE,
      MAP_PRIVATE | MAP_ANON,
      -1,
      0);
  if (control == MAP_FAILED) {
    return 42;
  }
  if (munmap(control, control_length) != 0 ||
      !current_virtual_size(&current) ||
      current > maximum) {
    return 43;
  }
  const uint64_t margin = UINT64_C(16777216);
  uint64_t remaining = maximum - current;
  if (remaining > UINT64_MAX - margin ||
      remaining + margin > (uint64_t)SIZE_MAX) {
    return 44;
  }
  size_t attempted = (size_t)(remaining + margin);
  errno = 0;
  void *mapping = mmap(
      NULL,
      attempted,
      PROT_NONE,
      MAP_PRIVATE | MAP_ANON,
      -1,
      0);
  if (mapping == MAP_FAILED) {
    return errno == ENOMEM ? 0 : 45;
  }
  (void)munmap(mapping, attempted);
  return 46;
}
