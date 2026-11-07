import type { SamApi, LibApi } from '../../preload/index';
declare global { interface Window { sam: SamApi; lib: LibApi } }
