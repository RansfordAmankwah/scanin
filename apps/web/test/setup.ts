import { configure } from '@testing-library/react';

// The first test in a file pays for importing the whole app; the default 1 s wait is too tight
// when the machine is busy (e.g. several packages' tests running in parallel).
configure({ asyncUtilTimeout: 5000 });
