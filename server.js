import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PopupRecharge from './PopupRecharge'; // Assuming this is your existing recharge modal
import RechargeSuccessPopup from './modals/RechargeSuccessPopup'; // Import the new success popup

export default function Home() {
  const [activeTab, setActiveTab] = useState('vendors');
  const navigate = useNavigate();
  const urlParams = new URLSearchParams(window.location.search);
  const [rechargeModalVisible, setRechargeModalVisible] = useState(false);
  const selectedPlanFromUrl = urlParams.get('selectedPlan') || '';
  // Note: 'selectedPlan' is used for mobileNumber here, ensure it's the correct param from your Cashfree return_url
  const mobileNumberForRechargeFromUrl = urlParams.get('mobileNumber') || '';
  const orderIdFromUrl = urlParams.get('order_id') || '';

  // New state for success popup
  const [showSuccessPopup, setShowSuccessPopup] = useState(false);
  const [processedOrderId, setProcessedOrderId] = useState('');
  const [showVerificationError, setShowVerificationError] = useState(false);
  const [verificationErrorMessage, setVerificationErrorMessage] = useState('');

  // --- useEffect to handle Cashfree redirection and verify payment ---
  useEffect(() => {
    const verifyPayment = async () => {
      // Clear URL parameters after reading them to prevent re-triggering on refresh
      const newUrl = new URL(window.location.href);
      let paramsRemoved = false;
      if (newUrl.searchParams.has('order_id')) {
        newUrl.searchParams.delete('order_id');
        paramsRemoved = true;
      }
      if (newUrl.searchParams.has('mobileNumber')) {
        newUrl.searchParams.delete('mobileNumber');
        paramsRemoved = true;
      }

      // Replace history state to clean the URL without reloading the page
      if (paramsRemoved) {
        window.history.replaceState({}, document.title, newUrl.pathname + newUrl.search);
      }

      if (orderIdFromUrl && mobileNumberForRechargeFromUrl) {
        console.log("Attempting to verify payment from URL parameters...");
        try {
          const response = await fetch('https://unorecharge.onrender.com/verify', { // Adjust endpoint if your backend is on a different URL
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              orderId: orderIdFromUrl,
              mobileNumber: mobileNumberForRechargeFromUrl,
            }),
          });

          const data = await response.json();
          console.log('Verification response:', data);

          if (data.success) {
            setProcessedOrderId(orderIdFromUrl);
            setShowSuccessPopup(true);
            // Optionally, you can navigate or update other UI elements here
          } else {
            // Handle specific statuses like FAILED, PENDING, etc.
            console.error('Payment verification failed or is pending:', data.message);
            setShowVerificationError(true);
            setVerificationErrorMessage(data.message || 'Payment could not be verified. Please check your payment status.');
          }
        } catch (error) {
          console.error('Error during payment verification:', error);
          setShowVerificationError(true);
          setVerificationErrorMessage('An error occurred during verification. Please contact support.');
        }
      }
    };

    // Only run verification if orderId and mobileNumber are present in the URL
    if (orderIdFromUrl && mobileNumberForRechargeFromUrl) {
      verifyPayment();
    }
  }, []); // Empty dependency array means this runs once on component mount

  const testimonials = [
    {
      text: "Increased my sales by 200% with worldwide reach",
      author: "Rajesh, Delhi",
      avatar: "👨‍💼"
    },
    {
      text: "Simplest inventory system I've ever used",
      author: "Priya, Mumbai",
      avatar: "👩‍💻"
    },
    {
      text: "Found unique products I couldn't find anywhere else",
      author: "Amit, Bangalore",
      avatar: "👨‍🎓"
    }
  ];

  const vendorFeatures = [
    {
      title: "Stock Management",
      desc: "Real-time inventory tracking",
      icon: "📊",
      img: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    },
    {
      title: "SKU Management",
      desc: "Organize products with custom SKUs and categories",
      icon: "#️⃣",
      img: "https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    },
    {
      title: "Image Upload",
      desc: "Bulk upload product images with ease",
      icon: "🖼️",
      img: "https://images.unsplash.com/photo-1522542550221-31fd19575a2d?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    },
    {
      title: "Global Reach",
      desc: "Sell to customers worldwide with localized support",
      icon: "🌎",
      img: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    },
    {
      title: "Order Dashboard",
      desc: "Get all orders in one unified dashboard",
      icon: "🛒",
      img: "https://images.unsplash.com/photo-1555529669-e69e7aa0ba9a?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    }
  ];

  const customerFeatures = [
    {
      title: "Global Marketplace",
      desc: "Shop from vendors across the world",
      icon: "🛍️",
      img: "https://images.unsplash.com/photo-1483985988355-763728e1935b?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    },
    {
      title: "Smart Search",
      desc: "Find exactly what you need with advanced filters",
      icon: "🔍",
      img: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    },
    {
      title: "One-Cart Checkout",
      desc: "Buy from multiple vendors in a single transaction",
      icon: "🛒",
      img: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    },
    {
      title: "Order Tracking",
      desc: "Real-time updates on all your purchases",
      icon: "🚚",
      img: "https://images.unsplash.com/photo-1504270997636-07ddfbd48945?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80"
    }
  ];

  return (
    <div style={{
      fontFamily: "'Poppins', sans-serif",
      maxWidth: '100%',
      margin: 0,
      padding: 0,
      backgroundColor: '#f9f9f9',
      color: '#333',
      minHeight: '100vh'
    }}>
      {/* Header */}
      <header style={{
        backgroundColor: '#fff',
        padding: '15px 20px',
        boxShadow: '0 2px 20px rgba(0,0,0,0.08)',
        position: 'sticky',
        top: 0,
        zIndex: 100
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          maxWidth: '1200px',
          margin: '0 auto'
        }}>
          <div style={{
            fontSize: '24px',
            fontWeight: 'bold',
            color: '#4CAF50',
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
          }}>
            <img style={{height:40, width:40, borderRadius:'50%'}} src="/usLogo.png" alt="" />
            UNOSHOPS
          </div>
          <div style={{
            display: 'flex',
            gap: '20px'
          }}>
            <button
              style={{
                background: 'none',
                border: 'none',
                padding: '8px 0',
                fontSize: '14px',
                fontWeight: '600',
                color: activeTab === 'vendors' ? '#4CAF50' : '#555',
                cursor: 'pointer',
                position: 'relative',
                marginLeft:10
              }}
              onClick={() => setActiveTab('vendors')}
            >
              For Vendors
              {activeTab === 'vendors' && <span style={{
                position: 'absolute',
                bottom: '-5px',
                left: '0',
                width: '100%',
                height: '3px',
                backgroundColor: '#4CAF50',
                borderRadius: '3px'
              }}></span>}
            </button>
            <button
              style={{
                background: 'none',
                border: 'none',
                padding: '8px 0',
                fontSize: '14px',
                fontWeight: '600',
                color: activeTab === 'customers' ? '#4CAF50' : '#555',
                cursor: 'pointer',
                position: 'relative'
              }}
              onClick={() => setActiveTab('customers')}
            >
              For Customers
              {activeTab === 'customers' && <span style={{
                position: 'absolute',
                bottom: '-5px',
                left: '0',
                width: '100%',
                height: '3px',
                backgroundColor: '#4CAF50',
                borderRadius: '3px'
              }}></span>}
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section style={{
        textAlign: 'center',
        padding: '60px 20px',
        background: 'linear-gradient(135deg, #4CAF50 0%, #8BC34A 100%)',
        color: 'white',
        position: 'relative',
        overflow: 'hidden'
      }}>
        <div style={{
          position: 'absolute',
          top: '-50px',
          right: '-50px',
          width: '200px',
          height: '200px',
          borderRadius: '50%',
          backgroundColor: 'rgba(255,255,255,0.1)'
        }}></div>
        <div style={{
          position: 'absolute',
          bottom: '-80px',
          left: '-80px',
          width: '300px',
          height: '300px',
          borderRadius: '50%',
          backgroundColor: 'rgba(255,255,255,0.1)'
        }}></div>
        <div style={{
          maxWidth: '800px',
          margin: '0 auto',
          position: 'relative',
          zIndex: 1
        }}>
          <h1 style={{
            fontSize: '2.5rem',
            fontWeight: '700',
            marginBottom: '20px',
            lineHeight: '1.2'
          }}>
            {activeTab === 'vendors'
              ? 'Grow Your Business Worldwide'
              : 'Shop From Global Vendors'}
          </h1>
          <p style={{
            fontSize: '1.1rem',
            marginBottom: '30px',
            maxWidth: '600px',
            marginLeft: 'auto',
            marginRight: 'auto',
            opacity: 0.9
          }}>
            {activeTab === 'vendors'
              ? 'Join thousands of vendors selling to customers across the globe with our powerful platform'
              : 'Discover unique products from carefully curated vendors worldwide'}
          </p>
          <a
            href={activeTab === 'vendors' ? 'https://vendors.unoshops.com' : 'https://customers.unoshops.com'}
            style={{
              display: 'inline-block',
              backgroundColor: 'white',
              color: '#4CAF50',
              padding: '15px 40px',
              borderRadius: '30px',
              textDecoration: 'none',
              fontWeight: '600',
              fontSize: '1rem',
              boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
              transition: 'all 0.3s ease',
              ':hover': {
                transform: 'translateY(-3px)',
                boxShadow: '0 15px 30px rgba(0,0,0,0.2)'
              }
            }}
          >
            {activeTab === 'vendors' ? 'Start Selling →' : 'Start Shopping →'}
          </a>
        </div>
      </section>

      {/* Features Section */}
      <section style={{
        padding: '20px',
        maxWidth: '1200px',
        margin: '0 auto'
      }}>
        <h2 style={{
          textAlign: 'center',
          fontSize: '2rem',
          marginBottom: '50px',
          color: '#333',
          position: 'relative',
          display: 'inline-block',
          marginLeft: '50%',
          transform: 'translateX(-50%)'
        }}>
          {activeTab === 'vendors' ? 'Vendor Features' : 'Customer Benefits'}
          <span style={{
            position: 'absolute',
            bottom: '-10px',
            left: '50%',
            width: '50px',
            height: '3px',
            backgroundColor: '#4CAF50',
            transform: 'translateX(-50%)'
          }}></span>
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '30px'
        }}>
          {(activeTab === 'vendors' ? vendorFeatures : customerFeatures).map((feature, index) => (
            <div key={index} style={{
              backgroundColor: 'white',
              borderRadius: '15px',
              overflow: 'hidden',
              boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
              transition: 'all 0.3s ease',
              ':hover': {
                transform: 'translateY(-10px)',
                boxShadow: '0 15px 40px rgba(0,0,0,0.12)'
              }
            }}>
              <div style={{
                height: '200px',
                backgroundImage: `url(${feature.img})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                position: 'relative'
              }}>
                <div style={{
                  position: 'absolute',
                  top: '20px',
                  right: '20px',
                  backgroundColor: 'rgba(76, 175, 80, 0.9)',
                  color: 'white',
                  width: '50px',
                  height: '50px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '24px'
                }}>
                  {feature.icon}
                </div>
              </div>
              <div style={{
                padding: '25px'
              }}>
                <h3 style={{
                  fontSize: '1.3rem',
                  fontWeight: '600',
                  marginBottom: '15px',
                  color: '#4CAF50'
                }}>
                  {feature.title}
                </h3>
                <p style={{
                  fontSize: '1rem',
                  color: '#666',
                  lineHeight: '1.6'
                }}>
                  {feature.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Testimonials */}
      <section style={{
        padding: '20px 20px',
        backgroundColor: '#f8faf8',
        backgroundImage: 'radial-gradient(#4CAF50 1px, transparent 1px)',
        backgroundSize: '20px 20px'
      }}>
        <div style={{
          maxWidth: '1200px',
          margin: '0 auto'
        }}>
          <h2 style={{
            textAlign: 'center',
            fontSize: '2rem',
            marginBottom: '50px',
            color: '#333'
          }}>
            Success Stories
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '30px'
          }}>
            {testimonials.map((testimonial, index) => (
              <div key={index} style={{
                backgroundColor: 'white',
                padding: '30px',
                borderRadius: '15px',
                boxShadow: '0 10px 30px rgba(0,0,0,0.05)',
                position: 'relative'
              }}>
                <div style={{
                  position: 'absolute',
                  top: '-20px',
                  left: '30px',
                  backgroundColor: '#4CAF50',
                  color: 'white',
                  width: '60px',
                  height: '60px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '30px'
                }}>
                  {testimonial.avatar}
                </div>
                <p style={{
                  fontSize: '1.1rem',
                  fontStyle: 'italic',
                  marginBottom: '20px',
                  color: '#555',
                  lineHeight: '1.6',
                  paddingTop: '30px'
                }}>
                  "{testimonial.text}"
                </p>
                <p style={{
                  fontWeight: '600',
                  color: '#4CAF50',
                  textAlign: 'right',
                  fontSize: '1rem'
                }}>
                  — {testimonial.author}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section style={{
        padding: '80px 20px',
        textAlign: 'center',
        background: 'linear-gradient(135deg, #4CAF50 0%, #8BC34A 100%)',
        color: 'white'
      }}>
        <div style={{
          maxWidth: '800px',
          margin: '0 auto'
        }}>
          <h2 style={{
            fontSize: '2rem',
            marginBottom: '20px'
          }}>
            Ready to {activeTab === 'vendors' ? 'grow your business' : 'start shopping'}?
          </h2>
          <p style={{
            fontSize: '1.1rem',
            marginBottom: '30px',
            opacity: 0.9
          }}>
            Join thousands of {activeTab === 'vendors' ? 'vendors' : 'customers'} already using Unoshops
          </p>
          <a
            href={activeTab === 'vendors' ? 'https://vendors.unoshops.com' : 'https://customers.unoshops.com'}
            style={{
              display: 'inline-block',
              backgroundColor: 'white',
              color: '#4CAF50',
              padding: '15px 40px',
              borderRadius: '30px',
              textDecoration: 'none',
              fontWeight: '600',
              fontSize: '1rem',
              boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
              transition: 'all 0.3s ease',
              ':hover': {
                transform: 'translateY(-3px)',
                boxShadow: '0 15px 30px rgba(0,0,0,0.2)'
              }
            }}
          >
            {activeTab === 'vendors' ? 'Join as Vendor →' : 'Start Shopping →'}
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer style={{
        backgroundColor: '#2c3e50',
        color: 'white',
        padding: '50px 20px 30px',
        textAlign: 'center'
      }}>
        <div style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
          gap: '40px',
          textAlign: 'left'
        }}>
          <div>
            <div style={{
              fontSize: '24px',
              fontWeight: 'bold',
              color: '#4CAF50',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px'
            }}>
              <img style={{height:40, width:40, borderRadius:'50%'}} src="/usLogo.png" alt="" />
              UNOSHOPS
            </div>
            <p style={{
              fontSize: '0.9rem',
              lineHeight: '1.6',
              opacity: 0.8
            }}>
              Connecting vendors with customers worldwide through our innovative platform.
            </p>
          </div>
          <div>
            <h3 style={{
              fontSize: '1.2rem',
              fontWeight: '600',
              marginBottom: '20px',
              color: '#4CAF50'
            }}>Quick Links</h3>
            <ul style={{
              listStyle: 'none',
              padding: 0,
              margin: 0
            }}>
              <li style={{ marginBottom: '10px' }}><a href="https://vendors.unoshops.com" style={{
                color: 'white',
                textDecoration: 'none',
                fontSize: '0.9rem',
                opacity: 0.8,
                transition: 'all 0.2s ease',
                ':hover': {
                  opacity: 1,
                  color: '#4CAF50'
                }
              }}>For Vendors</a></li>
              <li style={{ marginBottom: '10px' }}><a href="https://customers.unoshops.com" style={{
                color: 'white',
                textDecoration: 'none',
                fontSize: '0.9rem',
                opacity: 0.8,
                transition: 'all 0.2s ease',
                ':hover': {
                  opacity: 1,
                  color: '#4CAF50'
                }
              }}>For Customers</a></li>
              {activeTab === 'vendors' && <div><li style={{ marginBottom: '10px' }}><a onClick={() => navigate('/AboutUs/')} style={{
                color: 'white',
                textDecoration: 'none',
                fontSize: '0.9rem',
                opacity: 0.8,
                transition: 'all 0.2s ease',
                ':hover': {
                  opacity: 1,
                  color: '#4CAF50'
                }
              }}>About Us</a></li>
              <li style={{ marginBottom: '10px' }}><a onClick={() => navigate('/ContactUs/')} style={{
                color: 'white',
                textDecoration: 'none',
                fontSize: '0.9rem',
                opacity: 0.8,
                transition: 'all 0.2s ease',
                ':hover': {
                  opacity: 1,
                  color: '#4CAF50'
                }
              }}>Contact Us</a></li>
              <li style={{ marginBottom: '10px' }}><a onClick={() => navigate('/VendorsTermsAndConditions/')} style={{
                color: 'white',
                textDecoration: 'none',
                fontSize: '0.9rem',
                opacity: 0.8,
                transition: 'all 0.2s ease',
                ':hover': {
                  opacity: 1,
                  color: '#4CAF50'
                }
              }}>Vendors T&C</a></li>
              <li style={{ marginBottom: '10px' }}><a onClick={() => setRechargeModalVisible(!rechargeModalVisible)} style={{
                color: 'white',
                textDecoration: 'none',
                fontSize: '0.9rem',
                opacity: 0.8,
                transition: 'all 0.2s ease',
                ':hover': {
                  opacity: 1,
                  color: '#4CAF50'
                }
              }}>Recharge</a></li>
              <li style={{ marginBottom: '10px' }}><a onClick={() => navigate('/PrivacyPolicy/')} style={{
                color: 'white',
                textDecoration: 'none',
                fontSize: '0.9rem',
                opacity: 0.8,
                transition: 'all 0.2s ease',
                ':hover': {
                  opacity: 1,
                  color: '#4CAF50'
                }
              }}>Privacy Policy</a></li>
              <li style={{ marginBottom: '10px' }}><a onClick={() => navigate('/RefundPolicy/')} style={{
                color: 'white',
                textDecoration: 'none',
                fontSize: '0.9rem',
                opacity: 0.8,
                transition: 'all 0.2s ease',
                ':hover': {
                  opacity: 1,
                  color: '#4CAF50'
                }
              }}>Refund Policy</a></li></div>}
            </ul>
          </div>
          <div>
            <h3 style={{
              fontSize: '1.2rem',
              fontWeight: '600',
              marginBottom: '20px',
              color: '#4CAF50'
            }}>Contact Us</h3>
            <p style={{
              fontSize: '0.9rem',
              marginBottom: '15px',
              opacity: 0.8,
              display: 'flex',
              alignItems: 'center',
              gap: '10px'
            }}>
              <span>📧</span> unoshops1@gmail.com
            </p>
          </div>
        </div>
        <div style={{
          marginTop: '50px',
          paddingTop: '30px',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          textAlign: 'center'
        }}>
          <p style={{
            fontSize: '0.8rem',
            opacity: 0.7
          }}>
            © {new Date().getFullYear()} Unoshops. All rights reserved.
          </p>
        </div>
      </footer>
      {rechargeModalVisible && <div style={{position:'fixed', top:'50%', left:'50%', transform:'translate(-50%, -50%)', display:'flex', alignItems:'center', justifyContent:'center', width:'100%', zIndex:1}} >
        <PopupRecharge mobileNumberForRechargeFromUrl={mobileNumberForRechargeFromUrl} selectedPlanFromUrl={selectedPlanFromUrl}/>
        <img onClick={() => setRechargeModalVisible(!rechargeModalVisible)} style={{height:20, width:20, position:'fixed', top:5, right:'5%', padding:2, backgroundColor:'white'}} src="/crossImage.png" alt="" />
      </div>}

      {/* Conditional rendering for the success popup */}
      {showSuccessPopup && (
        <RechargeSuccessPopup
          onClose={() => setShowSuccessPopup(false)}
          orderId={processedOrderId}
        />
      )}

      {/* Conditional rendering for verification error message */}
      {showVerificationError && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(255, 0, 0, 0.2)', // Light red overlay
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 999
        }}>
          <div style={{
            backgroundColor: '#fff',
            padding: '30px',
            borderRadius: '10px',
            boxShadow: '0 5px 20px rgba(0,0,0,0.1)',
            textAlign: 'center',
            maxWidth: '400px',
            width: '90%',
            color: '#D32F2F' // Red text for error
          }}>
            <h3>Verification Error!</h3>
            <p>{verificationErrorMessage}</p>
            <button
              onClick={() => setShowVerificationError(false)}
              style={{
                backgroundColor: '#D32F2F',
                color: 'white',
                padding: '10px 20px',
                border: 'none',
                borderRadius: '5px',
                marginTop: '20px',
                cursor: 'pointer'
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
