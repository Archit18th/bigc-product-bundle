import React from 'react';
import ReactDOM from 'react-dom/client';
import { GlobalStyles, theme } from '@bigcommerce/big-design';
import { ThemeProvider } from 'styled-components';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <GlobalStyles />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
