import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import BundleList from './pages/BundleList';
import CreateBundle from './pages/CreateBundle';
import EditBundle from './pages/EditBundle';

export default function App() {
  return (
    <BrowserRouter basename="/app">
      <Routes>
        <Route path="/" element={<BundleList />} />
        <Route path="/bundles/new" element={<CreateBundle />} />
        <Route path="/bundles/:id/edit" element={<EditBundle />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
